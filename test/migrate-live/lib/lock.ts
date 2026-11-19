/**
 * One process at a time per source provider, and per Clerk instance: two runs
 * seeding, exporting or resetting the same provider, or importing into and
 * emptying the same Clerk instance, would wipe each other's users.
 *
 * A lock is a directory (mkdir is atomic) under data/.locks/ holding
 * owner.json. A lock whose process has gone is stale and is taken over. A
 * child process inherits PROVIDER_LOCKS from the holder and does not lock
 * again, so a batch can hold a provider while test:migrate seeds it.
 *
 * Locks are taken all-or-nothing: a caller never holds one lock while waiting
 * for another, so two callers can never wait on each other.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "data/.locks";

/** The lock name for a Clerk instance, next to the provider names. */
export const clerkLock = (instance: string) => `clerk-instance-${instance}`;
const held = new Set<string>();

/** Locks a parent process holds for us, fixed at start: never released here. */
const parentLocks = new Set((process.env.PROVIDER_LOCKS ?? "").split(",").filter(Boolean));
const inherited = () => parentLocks;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Children inherit what our parent holds plus what we hold. */
const syncEnv = () =>
  void (process.env.PROVIDER_LOCKS = [...new Set([...parentLocks, ...held])].join(","));

function releaseAll() {
  for (const p of held) rmSync(join(DIR, `${p}.lock`), { recursive: true, force: true });
  held.clear();
}
process.once("exit", releaseAll);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    releaseAll();
    process.exit(130);
  });
}

export type Holder = { name: string; what: string; pid: number; since: string };

/** Who holds `name`, or undefined if it is free (a stale lock is cleared). */
export function holderOf(name: string): Holder | undefined {
  const dir = join(DIR, `${name}.lock`);
  if (!existsSync(dir)) return undefined;
  const file = join(dir, "owner.json");
  const owner = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Omit<Holder, "name">)
    : undefined;
  if (owner && !alive(owner.pid)) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  return {
    name,
    what: owner?.what ?? "another run",
    pid: owner?.pid ?? 0,
    since: owner?.since ?? "?",
  };
}

/**
 * Takes every lock in `names` now, or none of them.
 *
 * @returns How to release what this call took, or who holds a lock it could not take.
 */
export function tryLock(
  names: string[],
  what: string,
): { release: () => void } | { holder: Holder } {
  mkdirSync(DIR, { recursive: true });
  const mine: string[] = [];
  const undo = () => {
    for (const n of mine) {
      rmSync(join(DIR, `${n}.lock`), { recursive: true, force: true });
      held.delete(n);
    }
    mine.length = 0;
    syncEnv();
  };
  for (const name of [...new Set(names)].sort()) {
    if (inherited().has(name) || held.has(name)) continue;
    let took = false;
    for (let attempt = 0; attempt < 2 && !took; attempt++) {
      try {
        mkdirSync(join(DIR, `${name}.lock`));
        took = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Taken: really held, or stale (then cleared, and worth one more try).
        const holder = holderOf(name);
        if (holder) {
          undo();
          return { holder };
        }
      }
    }
    if (!took) {
      undo();
      return { holder: holderOf(name) ?? { name, what: "another run", pid: 0, since: "?" } };
    }
    writeFileSync(
      join(DIR, `${name}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, what, since: new Date().toISOString() }),
    );
    held.add(name);
    mine.push(name);
  }
  syncEnv();
  return { release: undo };
}

/**
 * Waits for, then takes, every lock in `names` (all at once).
 *
 * @param what - Shown to anyone waiting, e.g. "test:migrate -p auth0".
 * @returns Releases the locks this call took.
 */
export async function lockProviders(
  names: string[],
  what: string,
  pollMs = 10_000,
): Promise<() => void> {
  let told = "";
  for (;;) {
    const r = tryLock(names, what);
    if ("release" in r) return r.release;
    const msg = `Waiting for ${r.holder.name}: ${r.holder.what} (pid ${r.holder.pid}) has had it since ${r.holder.since}`;
    if (msg !== told) console.log(msg);
    told = msg;
    await sleep(pollMs);
  }
}

export type ScheduleOptions = { pollMs?: number; maxWaitMs?: number; log?: (line: string) => void };

/**
 * Works through `items`, each under its own locks, skipping any that are
 * locked: take the first free item, run it, release, then start again from
 * the top of what is left. When every remaining item is locked, wait
 * `pollMs` (default 5 min) and look again. An item that stays locked for
 * `maxWaitMs` (default 1 h) without a break fails; the rest carry on.
 *
 * @returns The items that never got their locks, with who held them.
 */
export async function schedule<T>(
  items: T[],
  lockNames: (item: T) => string[],
  what: string,
  run: (item: T) => Promise<void>,
  opts: ScheduleOptions = {},
): Promise<{ item: T; holder: Holder }[]> {
  const pollMs = opts.pollMs ?? 5 * 60_000;
  const maxWaitMs = opts.maxWaitMs ?? 60 * 60_000;
  const log = opts.log ?? console.log;
  const pending = [...items];
  const blockedSince = new Map<T, number>();
  const failed: { item: T; holder: Holder }[] = [];

  while (pending.length) {
    let ran = false;
    for (const item of pending.slice()) {
      // a copy: the loop splices pending
      const r = tryLock(lockNames(item), what);
      if ("holder" in r) {
        const since = blockedSince.get(item) ?? Date.now();
        blockedSince.set(item, since);
        if (Date.now() - since >= maxWaitMs) {
          pending.splice(pending.indexOf(item), 1);
          failed.push({ item, holder: r.holder });
          log(
            `✗ ${lockNames(item).join(", ")}: still locked by ${r.holder.what} (pid ${r.holder.pid}) after ${Math.round(maxWaitMs / 60_000)} min; giving up on it`,
          );
        }
        continue;
      }
      blockedSince.delete(item);
      pending.splice(pending.indexOf(item), 1);
      try {
        await run(item);
      } finally {
        r.release();
      }
      ran = true;
      break; // back to the top of what is left
    }
    if (!ran && pending.length) {
      log(
        `All ${pending.length} remaining are locked (${pending.map((i) => lockNames(i).join("+")).join(", ")}); looking again in ${Math.round(pollMs / 60_000)} min`,
      );
      await sleep(pollMs);
    }
  }
  return failed;
}

/**
 * Takes the first free one of `options` (each a set of lock names), waiting
 * `pollMs` (5 min) between rounds and giving up after `maxWaitMs` (1 h).
 *
 * @returns Which option was taken, and how to release it.
 * @throws when none came free in time.
 */
export async function claimAny<T>(
  options: T[],
  lockNames: (o: T) => string[],
  what: string,
  opts: ScheduleOptions = {},
): Promise<{ taken: T; release: () => void }> {
  const pollMs = opts.pollMs ?? 5 * 60_000;
  const maxWaitMs = opts.maxWaitMs ?? 60 * 60_000;
  const start = Date.now();
  for (;;) {
    const holders: Holder[] = [];
    for (const o of options) {
      const r = tryLock(lockNames(o), what);
      if ("release" in r) return { taken: o, release: r.release };
      holders.push(r.holder);
    }
    if (Date.now() - start >= maxWaitMs) {
      throw new Error(
        `none of ${options.length} came free in ${Math.round(maxWaitMs / 60_000)} min (${holders.map((h) => `${h.name}: ${h.what}`).join("; ")})`,
      );
    }
    (opts.log ?? console.log)(
      `All ${options.length} busy; looking again in ${Math.round(pollMs / 60_000)} min`,
    );
    await sleep(pollMs);
  }
}

// Self-check (from test/migrate-live/): bun lib/lock.ts
if (process.argv[1]?.endsWith("lock.ts")) {
  const quiet = () => {};
  // Simulates another process holding `name`: the lock is ours on disk, but not in `held`.
  const holdElsewhere = (name: string) => {
    tryLock([name], "elsewhere");
    held.delete(name);
    return () => rmSync(join(DIR, `${name}.lock`), { recursive: true, force: true });
  };

  // All-or-nothing: with b held elsewhere, a+b takes neither.
  const freeB = holdElsewhere("selfcheck-b");
  const ab = tryLock(["selfcheck-a", "selfcheck-b"], "a+b");
  assert.ok("holder" in ab && ab.holder.name === "selfcheck-b");
  assert.ok(!existsSync(join(DIR, "selfcheck-a.lock")));
  // Another process waits for b; a child that inherits PROVIDER_LOCKS goes straight through.
  const other = spawnSync(
    "bun",
    [
      "-e",
      `import("./lib/lock.ts").then(m => m.lockProviders(["selfcheck-b"], "other", 300)).then(() => console.log("GOT"))`,
    ],
    {
      env: { ...process.env, PROVIDER_LOCKS: "" },
      timeout: 2500,
      encoding: "utf8",
    },
  );
  assert.match(other.stdout, /Waiting for selfcheck-b/);
  assert.doesNotMatch(other.stdout, /GOT/);
  const child = spawnSync(
    "bun",
    [
      "-e",
      `import("./lib/lock.ts").then(m => m.lockProviders(["selfcheck-b"], "child", 300)).then(() => console.log("GOT"))`,
    ],
    {
      env: { ...process.env, PROVIDER_LOCKS: "selfcheck-b" },
      timeout: 5000,
      encoding: "utf8",
    },
  );
  assert.match(child.stdout, /GOT/);
  freeB();

  // schedule: x is locked for a moment, so y runs first, then x; z stays locked and fails.
  const freeX = holdElsewhere("selfcheck-x");
  const freeZ = holdElsewhere("selfcheck-z");
  setTimeout(freeX, 150);
  const order: string[] = [];
  const failed = await schedule(
    ["x", "y", "z"],
    (i) => [`selfcheck-${i}`],
    "schedule test",
    async (i) => void order.push(i),
    {
      pollMs: 100,
      maxWaitMs: 600,
      log: quiet,
    },
  );
  assert.deepEqual(order, ["y", "x"]);
  assert.deepEqual(
    failed.map((f) => f.item),
    ["z"],
  );
  freeZ();

  // claimAny takes the first free option, and gives up when none frees.
  const freeT1 = holdElsewhere("selfcheck-t1");
  const got = await claimAny(["t1", "t2"], (t) => [`selfcheck-${t}`], "claim test", {
    pollMs: 50,
    maxWaitMs: 200,
    log: quiet,
  });
  assert.equal(got.taken, "t2");
  got.release();
  const freeT2 = holdElsewhere("selfcheck-t2");
  await assert.rejects(
    claimAny(["t1", "t2"], (t) => [`selfcheck-${t}`], "claim test", {
      pollMs: 50,
      maxWaitMs: 200,
      log: quiet,
    }),
    /none of 2/,
  );
  freeT1();
  freeT2();

  // A stale lock (dead pid) is taken over.
  mkdirSync(join(DIR, "selfcheck-s.lock"), { recursive: true });
  writeFileSync(
    join(DIR, "selfcheck-s.lock", "owner.json"),
    JSON.stringify({ pid: 999999, what: "dead", since: "then" }),
  );
  const s = tryLock(["selfcheck-s"], "takeover");
  assert.ok("release" in s);
  s.release();
  console.log("lock: ok");
}
