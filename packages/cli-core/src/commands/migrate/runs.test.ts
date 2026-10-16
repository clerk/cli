import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteArg } from "../../lib/json-body.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import {
  continueRun,
  type RunRecord,
  sha256File,
  startRun,
  type StartRunInit,
} from "./lib/run-store.ts";
import { runs } from "./runs.ts";

const captured = useCaptureLog();

let runsDir: string;

beforeEach(() => {
  runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-runs-")));
});

afterEach(() => {
  fs.rmSync(runsDir, { recursive: true, force: true });
});

const TARGET = { appLabel: "My App", env: "development", instanceId: "ins_1" };

/** The file the fixture's import read, so a continue can find it unchanged. */
const usersFile = () => path.join(runsDir, "users.json");

function partialImport(init: Partial<StartRunInit> = {}) {
  fs.writeFileSync(usersFile(), "[]");
  const run = startRun(runsDir, {
    kind: "import",
    target: TARGET,
    source: "clerk",
    file: { path: usersFile(), sha256: sha256File(usersFile()) },
    // What an import with none of the behaviour flags records.
    flags: {},
    ...init,
  });
  run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
  run.append({ sourceId: "b", status: "failed", error: "That email address is taken." });
  run.append({ sourceId: "c", status: "failed", error: "That email address is taken." });
  run.append({
    sourceId: "d",
    status: "skipped",
    reason: "no password (--require-password)",
    code: "no_password",
  });
  return run.finish();
}

/** A finished import of the same file and source, a second after `record`. */
function newerImport(record: RunRecord, instanceId: string) {
  const run = startRun(runsDir, {
    kind: "import",
    target: { ...record.target, instanceId },
    source: "clerk",
    file: record.file,
  });
  run.update({ startedAt: new Date(Date.parse(record.startedAt) + 1000).toISOString() });
  return run.finish();
}

describe("runs", () => {
  test("names the runs folder, then lists each run", async () => {
    const record = partialImport();

    await runs(undefined, { runsDir });

    expect(captured.err).toContain(`Runs folder: ${runsDir}`);
    expect(captured.err).toContain(record.id);
    expect(captured.err).toContain("My App (development, ins_1)");
    expect(captured.err).toContain("1 created, 2 failed, 1 skipped");
  });

  // Counts are written at the finish, which an interrupted run never reaches.
  test("counts an interrupted run from its user lines", async () => {
    const run = startRun(runsDir, {
      kind: "import",
      target: { env: "development", instanceId: "ins_1" },
      source: "clerk",
    });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    run.append({ sourceId: "b", status: "created", clerkId: "user_b" });
    fs.rmSync(path.join(run.dir, "lock"));

    await runs(undefined, { runsDir });

    expect(captured.err).toContain("interrupted");
    expect(captured.err).toContain("2 created");
  });

  test("says so when there are no runs", async () => {
    await runs(undefined, { runsDir });
    expect(captured.err).toContain("No migration runs yet.");
  });

  test("--json lists the runs on stdout, with each one's state", async () => {
    const record = partialImport();

    await runs(undefined, { runsDir, json: true });

    const parsed = JSON.parse(captured.out) as { runsDir: string; runs: { id: string }[] };
    expect(parsed).toMatchObject({ runsDir, runs: [{ id: record.id, state: "partial" }] });
  });
});

describe("runs <id>", () => {
  test("shows the counts, the error breakdown and who did not make it", async () => {
    const record = partialImport();

    await runs(record.id, { runsDir });

    expect(captured.err).toContain("partial");
    expect(Bun.stripANSI(captured.err)).toContain("2 users: That email address is taken.");
    expect(captured.err).toContain("Failed (2)");
    expect(captured.err).toContain("Skipped (1)");
    expect(captured.err).toContain("no password (--require-password)");
    expect(captured.err).toContain(path.join(runsDir, record.id, "users.ndjson"));
  });

  test("--json returns the run, its errors, and the failed and skipped users", async () => {
    const record = partialImport();

    await runs(record.id, { runsDir, json: true });

    const parsed = JSON.parse(captured.out) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      run: { id: record.id, state: "partial", counts: { created: 1, failed: 2, skipped: 1 } },
      errors: [{ error: "That email address is taken.", count: 2 }],
      failed: [{ sourceId: "b" }, { sourceId: "c" }],
      skipped: [{ sourceId: "d" }],
    });
  });

  // The import counted these as failed, so `runs` lists them and why: a
  // create no answer confirmed, and a user with an email left to attach.
  test("shows creates no answer confirmed, and identifiers left to attach", async () => {
    fs.writeFileSync(usersFile(), "[]");
    const run = startRun(runsDir, {
      kind: "import",
      target: TARGET,
      source: "clerk",
      file: { path: usersFile(), sha256: sha256File(usersFile()) },
    });
    run.append({ sourceId: "a", status: "creating" });
    run.append({ sourceId: "a", status: "creating", error: "bad gateway (a re-run checks)" });
    run.append({
      sourceId: "b",
      status: "created",
      clerkId: "user_b",
      pending: [{ kind: "email", value: "b2@x.dev", verified: true }],
    });
    const record = run.finish();

    await runs(record.id, { runsDir, json: true });
    expect(JSON.parse(captured.out)).toMatchObject({
      run: { state: "partial", counts: { creating: 1, pending: 1 } },
      errors: [{ error: "bad gateway (a re-run checks)", count: 1 }],
      unconfirmed: [{ sourceId: "a" }],
    });

    captured.clear();
    await runs(record.id, { runsDir });
    const err = Bun.stripANSI(captured.err);
    expect(err).toContain("1 created, 1 left to attach, 1 not confirmed");
    expect(err).toContain("Not confirmed (Clerk may have created them; a continue checks) (1)");
    expect(err).toContain("1 user: bad gateway (a re-run checks)");
  });

  // A stopped import's unsent users have no lines: only the count says so.
  test("shows the users a stopped import never sent, in the list and the run", async () => {
    fs.writeFileSync(usersFile(), "[]");
    const run = startRun(runsDir, {
      kind: "import",
      target: TARGET,
      source: "clerk",
      file: { path: usersFile(), sha256: sha256File(usersFile()) },
      flags: {},
    });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    const record = run.finish({ notSent: 9000 });

    await runs(undefined, { runsDir });
    expect(Bun.stripANSI(captured.err)).toContain("1 created, 9000 not sent");

    captured.clear();
    await runs(record.id, { runsDir });
    expect(Bun.stripANSI(captured.err)).toContain("1 created, 9000 not sent");
  });

  // An unfinished run is counted from its lines, `pending` included.
  test("counts identifiers left to attach on a run that never finished", async () => {
    const record = partialImport();
    const run = continueRun(runsDir, record);
    run.append({
      sourceId: "e",
      status: "created",
      clerkId: "user_e",
      pending: [{ kind: "email", value: "e2@x.dev", verified: true }],
    });
    run.release();

    await runs(record.id, { runsDir });

    expect(Bun.stripANSI(captured.err)).toContain("interrupted");
    expect(Bun.stripANSI(captured.err)).toContain("2 created, 1 left to attach");
  });

  // The record says where the key came from, and which instance to reach
  // again. One row per key source, so none is left to drop its target.
  test.each([
    [{ keySource: "--secret-key" }, "--secret-key <key>"],
    [{ keySource: "--app", appId: "app_1" }, "--app app_1 --instance ins_1"],
    // Left out, a profile resolves development, and only from its own directory.
    [{ keySource: "linked profile", appId: "app_1" }, "--app app_1 --instance ins_1"],
    // Maybe no longer exported, and `--instance` is refused next to a `.env`.
    [{ keySource: "CLERK_SECRET_KEY env var" }, "--secret-key <key>"],
    // A framework's own variable, exported the same way: without it, `.env`'s
    // key would be read instead.
    [{ keySource: "NUXT_CLERK_SECRET_KEY env var" }, "--secret-key <key>"],
    // Both refuse `--instance`, and the file names the key.
    [{ keySource: ".env" }, "--runs-dir"],
    [{ keySource: "accountless app (.clerk/.tmp/keyless.json)" }, "--runs-dir"],
    // No `--instance` resolves a stand-in, and a bare `--app` resolves development: the key.
    [
      { keySource: "--app", appId: "app_1", instanceId: "key_abc" },
      "--secret-key <key> --runs-dir",
    ],
    [
      { keySource: "linked profile", appId: "app_1", instanceId: "key_abc" },
      "--secret-key <key> --runs-dir",
    ],
  ])("the next command keeps the import's target from %o", async (target, expected) => {
    const record = partialImport();
    const file = path.join(runsDir, record.id, "run.json");
    fs.writeFileSync(file, JSON.stringify({ ...record, target: { ...record.target, ...target } }));

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next.at(-1)).toContain(`clerk migrate undo ${record.id} ${expected}`);
  });

  // The suggested undo has to look in the same runs folder.
  test("the next command keeps the runs folder", async () => {
    const record = partialImport();

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next.at(-1)).toContain(
      `clerk migrate undo ${record.id} --runs-dir ${quoteArg(runsDir)}`,
    );
  });

  // A partial run is continued by importing the same file again.
  test("a partial import suggests re-running it, then undoing it", async () => {
    const record = partialImport();

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next).toHaveLength(2);
    expect(next[0]).toContain(
      `clerk migrate import ${quoteArg(usersFile())} --source clerk --runs-dir ${quoteArg(runsDir)}`,
    );
    expect(next[0]).toContain("to retry the users it didn't finish");
    // Run as printed, it goes ahead rather than asking for consent.
    expect(next[0]).toContain(`--runs-dir ${quoteArg(runsDir)} --yes\``);
  });

  // An earlier build of this branch wrote none, or a string[]: a continue
  // without them would create the users --require-password held back.
  test.each([
    ["no flags", undefined],
    ["flags as a string[]", ["--require-password"]],
  ])("offers no continue for a run with %s", async (_, flags) => {
    const record = partialImport({ flags: flags as StartRunInit["flags"] });

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next).toEqual([expect.stringContaining(`clerk migrate undo ${record.id}`)]);
  });

  // Left out, the continue creates the users --require-password held back.
  test("the continue repeats the flags the import ran with", async () => {
    const record = partialImport({ flags: { requirePassword: true } });

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next[0]).toContain("--source clerk --require-password --runs-dir");
  });

  // The continue carries --require-password, so it would leave them out again.
  test("offers no continue when only --require-password skips are left", async () => {
    fs.writeFileSync(usersFile(), "[]");
    const run = startRun(runsDir, {
      kind: "import",
      target: TARGET,
      source: "clerk",
      file: { path: usersFile(), sha256: sha256File(usersFile()) },
      flags: { requirePassword: true },
    });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    run.append({
      sourceId: "d",
      status: "skipped",
      reason: "no password (--require-password)",
      code: "no_password",
    });
    const record = run.finish();

    await runs(record.id, { runsDir, json: true });

    const { run: shown, next } = JSON.parse(captured.out) as { run: RunRecord; next: string[] };
    expect(shown.status).toBe("partial");
    expect(next).toEqual([expect.stringContaining(`clerk migrate undo ${record.id}`)]);
  });

  // Each of these would start another run, or refuse, rather than continue it.
  describe("offers only the undo when importing the file again would not continue the run", () => {
    const onlyUndo = async (id: string) => {
      await runs(id, { runsDir, json: true });
      const { next } = JSON.parse(captured.out) as { next: string[] };
      expect(next).toEqual([expect.stringContaining(`clerk migrate undo ${id}`)]);
    };

    // In the stand-in rows, `runs` has no key, so it can't tell whether a
    // stand-in is `ins_1`: an import with that key could take the newer run.
    test.each([
      ["a newer run of the same file", "ins_1", "ins_1"],
      ["a newer run under a key's stand-in, when this one has a real ID", "ins_1", "key_abc"],
      ["a newer run under a real ID, when this one has a key's stand-in", "key_abc", "ins_1"],
    ])("%s", async (_name, instanceId, newerInstanceId) => {
      const record = partialImport({ target: { ...TARGET, instanceId } });
      newerImport(record, newerInstanceId);

      await onlyUndo(record.id);
    });

    test("a file changed since", async () => {
      const record = partialImport();
      fs.writeFileSync(usersFile(), "[{}]");

      await onlyUndo(record.id);
    });

    test("an undo of it left unfinished", async () => {
      const record = partialImport();
      startRun(runsDir, { kind: "undo", target: record.target, undoes: record.id }).release();

      await onlyUndo(record.id);
    });

    // Cut off before it marked the import undone: an import starts a new run.
    test("an undo of it that finished", async () => {
      const record = partialImport();
      startRun(runsDir, { kind: "undo", target: record.target, undoes: record.id }).finish();

      await onlyUndo(record.id);
    });
  });

  // Dev first, then prod, from the same file: the dev run is still the one
  // an import into dev continues.
  test("a newer run on another instance keeps the continue", async () => {
    const record = partialImport();
    newerImport(record, "ins_2");

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next).toHaveLength(2);
    expect(next[0]).toContain("to retry the users it didn't finish");
  });

  test("an unknown ID is a usage error", async () => {
    await expect(runs("nope", { runsDir })).rejects.toThrow(/No run `nope`/);
  });

  test("an unknown ID lists the same runs folder", async () => {
    await expect(runs("nope", { runsDir })).rejects.toThrow(
      `clerk migrate runs --runs-dir ${quoteArg(runsDir)}`,
    );
  });
});
