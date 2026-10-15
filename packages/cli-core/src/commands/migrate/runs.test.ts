import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteArg } from "../../lib/json-body.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { type RunRecord, sha256File, startRun, type StartRunInit } from "./lib/run-store.ts";
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
    ...init,
  });
  run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
  run.append({ sourceId: "b", status: "failed", error: "That email address is taken." });
  run.append({ sourceId: "c", status: "failed", error: "That email address is taken." });
  run.append({ sourceId: "d", status: "skipped", reason: "no password (--require-password)" });
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

  // The record says where the key came from, and which instance to reach again.
  test.each([
    [{ keySource: "--secret-key" }, "--secret-key <key>"],
    [{ keySource: "--app", appId: "app_1" }, "--app app_1 --instance ins_1"],
    // Left out, a linked profile resolves the development instance.
    [{ keySource: "linked profile", appId: "app_1" }, "--instance ins_1"],
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
    expect(next[0]).toContain("to retry the users that failed or were skipped");
  });

  // Left out, the continue creates the users --require-password held back.
  test("the continue repeats the flags the import ran with", async () => {
    const record = partialImport({ flags: { requirePassword: true } });

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next[0]).toContain("--source clerk --require-password --runs-dir");
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
    expect(next[0]).toContain("to retry the users that failed or were skipped");
  });

  // The record has the custom source's hash, not its path.
  test("a partial import from a source you wrote names the source file to pass", async () => {
    const record = partialImport({ source: "acme", sourceHash: "abc123" });

    await runs(record.id, { runsDir, json: true });

    const { next } = JSON.parse(captured.out) as { next: string[] };
    expect(next[0]).toContain(`clerk migrate import ${quoteArg(usersFile())} --source SOURCE_FILE`);
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
