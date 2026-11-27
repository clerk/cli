/**
 * What every live test needs from Clerk: the instances, the migrate CLI, and
 * the waits that make Clerk's listings trustworthy. Shared by test-migrate.ts
 * and test-custom-source.ts.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClerkClient, type User } from "@clerk/backend";
import { run } from "./run";
import { pool, withRetry } from "./users";

/** argv prefix that runs a CLI: a cli.ts path (or pinCli's bundle) runs with bun, anything else is a binary (e.g. `clerk`). */
export const cliArgv = (cli: string) => (/\.[jt]s$/.test(cli) ? ["bun", cli] : [cli]);

/**
 * Freezes a cli.ts checkout for one batch: bundles it into `dir/cli.js`, so a
 * commit to the CLI mid-batch no longer changes what later runs are graded on.
 * The keychain module is native and won't load from a bundle, so it stays
 * external and resolves through NODE_PATH, which every child process inherits.
 * Anything that isn't a cli.ts path is returned as it is.
 */
export function pinCli(cli: string, dir: string): string {
  if (!cli.endsWith(".ts")) return cli;
  execFileSync(
    "bun",
    ["build", cli, "--target=bun", "--external", "@napi-rs/keyring", "--outdir", dir],
    { stdio: "ignore" },
  );
  // The keyring (your `clerk auth login`) stays outside the bundle, so it has to be findable: a workspace
  // install keeps it in packages/cli-core/node_modules or hoists it to the checkout's root, so try each folder up.
  const up = (d: string): string[] =>
    dirname(d) === d ? [] : [join(d, "node_modules"), ...up(dirname(d))];
  process.env.NODE_PATH = [
    ...up(dirname(dirname(cli))).filter((d) => existsSync(d)),
    process.env.NODE_PATH,
  ]
    .filter(Boolean)
    .join(":");
  return join(dir, "cli.js");
}

/**
 * Which build of the CLI ran: the checkout's commit (plus "dirty" when it has
 * uncommitted changes) for a cli.ts path or pinCli's bundle, else the binary's --version.
 */
export function cliVersion(cli: string): string {
  try {
    if (cli.endsWith(".js")) {
      // The bundle's version was stamped at build time: 3.4.0-dev.20261007.b32dcdf7[.dirty]
      const v = execFileSync("bun", [cli, "--version"], { encoding: "utf8" }).trim();
      const m = v.match(/\.([0-9a-f]{7,})(\.dirty)?$/);
      return m ? `${m[1]}${m[2] ? " (dirty)" : ""}` : v;
    }
    if (!cli.endsWith(".ts"))
      return execFileSync(cli, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dirname(cli), ...a], { encoding: "utf8" }).trim();
    return `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " (dirty)" : ""}`;
  } catch {
    return "unknown";
  }
}

/** The environment around a run failed (not the thing under test): report it as not run, not as a fail. */
export class SetupError extends Error {
  override name = "SetupError";
}

/** This checkout's CLI, so a run tests the code it sits next to. */
export const DEFAULT_CLI = join(import.meta.dir, "../../../packages/cli-core/src/cli.ts");

type Target = { app: string; instance: string; key: string };

/**
 * Clerk instances test:migrate can import into. `dev` takes every test except
 * the 10K ones (and is the Clerk-as-source instance too); the other two are
 * 10K only. `dev` is the migrate-tests instance: its key and app ID come from
 * the environment (1Password or CI secrets), and its instance ID from its key, so call
 * `resolveTargets()` once before reading `TARGETS.dev.instance`.
 */
export const TARGETS: Record<"dev" | "10k-dev" | "10k-prod", Target> = {
  dev: {
    app: process.env.CLERK_MIGRATE_TESTS_1_APP_ID ?? "",
    instance: "",
    key: "CLERK_MIGRATE_TESTS_1_SECRET_KEY",
  },
  "10k-dev": {
    app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ",
    instance: "ins_3JVnO75emwoOfD4sY7FeE5BDJFi",
    key: "CLERK_SECRET_KEY_10K_DEV",
  },
  "10k-prod": {
    app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ",
    instance: "ins_3JVszqLLBrKGLYjh7Ag1f4kRGny",
    key: "CLERK_SECRET_KEY_10K_PROD",
  },
};

/** The instance a Backend API secret key belongs to (GET /v1/instance). */
export async function instanceIdOf(secretKey: string): Promise<string> {
  const res = await fetch("https://api.clerk.com/v1/instance", {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`Clerk answered ${res.status} for GET /v1/instance`);
  return ((await res.json()) as { id: string }).id;
}

/** Fills in what TARGETS takes from the environment: the dev instance's ID, from its key. */
export async function resolveTargets() {
  const key = process.env[TARGETS.dev.key];
  if (!TARGETS.dev.instance && key) TARGETS.dev.instance = await instanceIdOf(key);
}

/**
 * @param opts.cli - Path to the CLI's cli.ts (run with bun), or a binary such as `clerk`.
 * @param opts.log - File every CLI command and its stderr is appended to.
 * @param opts.env - Extra env for every CLI call.
 */
export function clerkRun(opts: {
  cli: string;
  secretKey: string;
  log: string;
  env?: Record<string, string>;
}) {
  const clerk = createClerkClient({ secretKey: opts.secretKey });

  /**
   * Runs the migrate CLI; stdout is JSON under --json, stderr goes to the log.
   * @param timeoutMs - Kill it after this long (exit code 124).
   */
  async function cli(
    args: string[],
    env: Record<string, string | undefined> = {},
    timeoutMs?: number,
  ) {
    const [bin, ...pre] = cliArgv(opts.cli);
    const result = await run(
      bin,
      [...pre, ...args],
      {
        // The target's key, so nothing in the CLI can fall back to another instance.
        ...process.env,
        CLERK_TELEMETRY_DISABLED: "1",
        CLERK_SECRET_KEY: opts.secretKey,
        ...opts.env,
        ...env,
      },
      { timeoutMs },
    );
    appendFileSync(opts.log, `$ clerk ${args.join(" ")}\n${result.stderr}\n`);
    let json: any = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      /* not JSON (config commands print text) */
    }
    return { code: result.code, json, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Clerk's user count lags deletes by a few seconds: straight after an undo it
   * can still report users that are gone (seen live: "already has 3 users" after
   * F3's undo, 0 a moment later). Poll for up to a minute before trusting it.
   */
  async function settledCount(timeoutMs = 60_000, want = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = await withRetry(() => clerk.users.getCount(), 8);
      if (n === want || Date.now() > deadline) return n;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async function clerkUsers(): Promise<User[]> {
    const users: User[] = [];
    for (let offset = 0; ; offset += 500) {
      // Right after an import the instance's rate budget is spent: retry 429s.
      const { data } = await withRetry(() => clerk.users.getUserList({ limit: 500, offset }), 8);
      users.push(...data);
      if (data.length < 500) return users;
    }
  }

  /**
   * Every user with a password must actually sign in with the seed password.
   * Past 500 users (the 10K runs) a spread sample of 200 stands in for all of
   * them — 8,500 verify calls would take longer than the import.
   */
  async function verifyPasswords(users: User[], password: string) {
    const all = users.filter((u) => u.passwordEnabled);
    const step = all.length > 500 ? Math.ceil(all.length / 200) : 1;
    const withPassword = all.filter((_, i) => i % step === 0);
    const bad: string[] = [];
    await pool(withPassword, 4, async (u) => {
      const ok = await clerk.users
        .verifyPassword({ userId: u.id, password })
        .then((r) => r.verified)
        .catch((e) => {
          if (e?.status === 429) throw e; // let pool's retry handle throttling
          return false;
        });
      if (!ok) bad.push(u.id);
    });
    return { checked: withPassword.length, failed: bad };
  }

  /**
   * `clerk config patch`, with a timeout and retries: the Platform API has been
   * seen to hang for over an hour before answering "The operation timed out."
   *
   * @throws SetupError after the last attempt, so callers can tell a broken
   *   setup from a result.
   */
  async function patchConfig(target: string[], body: object, attempts = 3, timeoutMs = 120_000) {
    let last = "";
    for (let i = 1; i <= attempts; i++) {
      const r = await cli(
        ["config", "patch", ...target, "--json", JSON.stringify(body), "--yes"],
        {},
        timeoutMs,
      );
      if (r.code === 0) return;
      last =
        r.code === 124
          ? `timed out after ${timeoutMs / 1000}s`
          : `exit ${r.code}: ${(r.json?.error?.message ?? r.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`;
      appendFileSync(opts.log, `!! config patch attempt ${i}/${attempts} failed: ${last}\n`);
      if (i < attempts) await new Promise((res) => setTimeout(res, 10_000 * i));
    }
    throw new SetupError(`clerk config patch failed ${attempts} times; last: ${last}`);
  }

  return { clerk, cli, settledCount, clerkUsers, verifyPasswords, patchConfig };
}
