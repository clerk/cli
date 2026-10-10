import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../../lib/config.ts";
import {
  continueRun,
  latestUserLines,
  listRuns,
  lockFile,
  lockImport,
  newRunId,
  patchRun,
  readRun,
  resolveRunsDir,
  runState,
  RUNS_DIR_ENV,
  startRun,
} from "./run-store.ts";

let workDir: string;
let configDir: string;
let runsDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  originalEnv = process.env[RUNS_DIR_ENV];
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-run-store-config-"));
  _setConfigDir(configDir);
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env[RUNS_DIR_ENV];
  else process.env[RUNS_DIR_ENV] = originalEnv;
  _setConfigDir(undefined);
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env[RUNS_DIR_ENV];
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-run-store-")));
  runsDir = path.join(workDir, "runs");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const init = { kind: "import" as const, target: { instanceId: "ins_1" }, source: "clerk" };

describe("resolveRunsDir", () => {
  test("prefers --runs-dir, resolved against the cwd", async () => {
    process.env[RUNS_DIR_ENV] = "/from/env";
    expect(await resolveRunsDir("flag", { cwd: workDir })).toBe(path.join(workDir, "flag"));
  });

  test("falls back to CLERK_MIGRATE_DIR", async () => {
    process.env[RUNS_DIR_ENV] = "from-env";
    expect(await resolveRunsDir(undefined, { cwd: workDir })).toBe(path.join(workDir, "from-env"));
  });

  test("defaults to .clerk/migrate in the project, gitignored only when writing", async () => {
    expect(await resolveRunsDir(undefined, { cwd: workDir })).toBe(
      path.join(workDir, ".clerk", "migrate"),
    );
    expect(fs.existsSync(path.join(workDir, ".gitignore"))).toBe(false);

    await resolveRunsDir(undefined, { cwd: workDir, write: true });
    expect(fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8")).toBe(".clerk/\n");
  });
});

describe("a run's life", () => {
  test("IDs sort by start time and read as a date", () => {
    expect(newRunId(new Date(2026, 8, 29, 14, 5, 2))).toMatch(/^20260929-140502-[0-9a-f]{4}$/);
  });

  test("starts running, holding a lock", () => {
    const run = startRun(runsDir, init);
    expect(readRun(runsDir, run.record.id)).toMatchObject({ status: "running", kind: "import" });
    expect(fs.readFileSync(path.join(run.dir, "lock"), "utf-8")).toBe(String(process.pid));
  });

  test("finishes complete when every user made it", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });

    const record = run.finish();

    expect(record).toMatchObject({ status: "complete", counts: { total: 1, created: 1 } });
    expect(record.finishedAt).toBeDefined();
    expect(fs.existsSync(path.join(run.dir, "lock"))).toBe(false);
  });

  test.each([["failed"], ["skipped"], ["creating"]] as const)(
    "finishes partial when a user was %s",
    (status) => {
      const run = startRun(runsDir, init);
      run.append({ sourceId: "a", status: "created" });
      run.append({ sourceId: "b", status });
      expect(run.finish().status).toBe("partial");
    },
  );

  test("counts each source ID by its last line", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "failed", error: "boom" });
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });

    expect(run.finish()).toMatchObject({ status: "complete", counts: { total: 1, created: 1 } });
    expect(latestUserLines(runsDir, run.record.id).get("a")?.clerkId).toBe("user_a");
  });

  test("reads past a line a crash cut short", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created" });
    fs.appendFileSync(path.join(run.dir, "users.ndjson"), '{"sourceId":"b","sta');

    expect([...latestUserLines(runsDir, run.record.id).keys()]).toEqual(["a"]);
  });

  test("a continued run starts a fresh line after one a crash cut short", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created" });
    fs.appendFileSync(path.join(run.dir, "users.ndjson"), '{"sourceId":"b","sta');
    fs.rmSync(path.join(run.dir, "lock"));

    continueRun(runsDir, run.record).append({ sourceId: "c", status: "created" });

    expect([...latestUserLines(runsDir, run.record.id).keys()]).toEqual(["a", "c"]);
  });

  // A user created with no line is beyond both undo and a re-run, so the
  // create that would follow must not go out.
  test("append throws when the line cannot be written", () => {
    const run = startRun(runsDir, init);
    fs.mkdirSync(path.join(run.dir, "users.ndjson"));

    expect(() => run.append({ sourceId: "a", status: "creating" })).toThrow();
  });
});

describe("locks and interruptions", () => {
  // A PID no process can have.
  const DEAD_PID = "2147483646";

  test("a run whose process died is interrupted", () => {
    const run = startRun(runsDir, init);
    fs.writeFileSync(path.join(run.dir, "lock"), DEAD_PID);
    expect(runState(runsDir, run.record)).toBe("interrupted");
  });

  test("a run with no lock and no finish time is interrupted", () => {
    const run = startRun(runsDir, init);
    fs.rmSync(path.join(run.dir, "lock"));
    expect(runState(runsDir, run.record)).toBe("interrupted");
  });

  // Undo marks an interrupted import undone, but leaves it with no finish time.
  test("an interrupted run that was undone reads as undone", () => {
    const run = startRun(runsDir, init);
    fs.rmSync(path.join(run.dir, "lock"));
    expect(runState(runsDir, { ...run.record, status: "undone" })).toBe("undone");
  });

  test("continuing takes the lock from a dead process and reopens the run", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created" });
    run.finish();

    const again = continueRun(runsDir, readRun(runsDir, run.record.id)!);
    expect(again.record).toMatchObject({ id: run.record.id, status: "running" });
    expect(again.record.finishedAt).toBeUndefined();
    again.append({ sourceId: "b", status: "created" });
    expect(again.finish().counts.total).toBe(2);
  });

  // In a container the CLI often gets the same PID every run, so a killed
  // run's lock can hold this process's own PID.
  test("a lock holding this process's own PID is stale", () => {
    const run = startRun(runsDir, init);
    expect(runState(runsDir, run.record)).toBe("interrupted");
    expect(() => continueRun(runsDir, run.record)).not.toThrow();
  });

  // A lock created empty and written after reads as stale to a second
  // process in between, which would remove it and import beside the first.
  test("a lock is linked into place with its PID already written", () => {
    const identity = { sha256: "a".repeat(64), source: "supabase", instanceId: "ins_lock" };
    const write = spyOn(fs, "writeFileSync");
    try {
      const release = lockImport(runsDir, identity);
      const lockPaths = write.mock.calls.map(([target]) => String(target));
      expect(lockPaths.every((target) => target.endsWith(".tmp"))).toBe(true);
      release();
    } finally {
      write.mockRestore();
    }
  });

  test("reads as running while another live process holds the lock", () => {
    const run = startRun(runsDir, init);
    fs.writeFileSync(path.join(run.dir, "lock"), "1");
    expect(runState(runsDir, run.record)).toBe("running");
  });

  // Two runs in the same second share an ID one time in 65,536.
  test("a run ID that is already taken gets a new one, not a shared folder", () => {
    setSystemTime(new Date("2026-10-02T12:00:00"));
    const bytes = spyOn(crypto, "randomBytes")
      .mockReturnValueOnce(Buffer.from([0xab, 0xcd]) as never)
      .mockReturnValueOnce(Buffer.from([0xab, 0xcd]) as never)
      .mockReturnValueOnce(Buffer.from([0x12, 0x34]) as never);
    try {
      const first = startRun(runsDir, init);
      const second = startRun(runsDir, init);
      expect(first.record.id).toEndWith("-abcd");
      expect(second.record.id).toEndWith("-1234");
    } finally {
      bytes.mockRestore();
      setSystemTime();
    }
  });

  // Windows ignores POSIX modes.
  test.skipIf(process.platform === "win32")("run folders are owner-only", () => {
    const run = startRun(runsDir, init);
    expect(fs.statSync(run.dir).mode & 0o777).toBe(0o700);
  });

  // In case a folder's mode is ever looser than the run store sets it.
  // Users never sent have no line to count, so the caller says how many.
  test("a finish with users never sent is partial", () => {
    const sent = startRun(runsDir, init);
    sent.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    expect(sent.finish().status).toBe("complete");

    const stopped = startRun(runsDir, init);
    stopped.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    const record = stopped.finish({ notSent: 2 });
    expect(record.status).toBe("partial");
    // Saved, so a later reader can tell how many were never sent.
    expect(readRun(runsDir, record.id)?.counts).toEqual({ total: 1, created: 1, notSent: 2 });
  });

  test("release leaves the run unfinished and unlocked", () => {
    const run = startRun(runsDir, init);
    run.release();
    expect(readRun(runsDir, run.record.id)?.finishedAt).toBeUndefined();
    expect(fs.existsSync(path.join(run.dir, "lock"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("run files are owner-only", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "u1", status: "creating" });
    for (const file of ["run.json", "users.ndjson", "lock"]) {
      expect(fs.statSync(path.join(run.dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  test("refuses a run another live process holds, with exit 2", () => {
    const run = startRun(runsDir, init);
    // PID 1 is always alive, and never this test.
    fs.writeFileSync(path.join(run.dir, "lock"), "1");

    expect(() => continueRun(runsDir, run.record)).toThrow(
      new RegExp(
        `in use by another process \\(PID 1\\).*delete ${path.join(run.dir, "lock")}`,
        "s",
      ),
    );
  });
});

// A continue plans from what it read before its consent prompt; an undo or
// another continue can write to the run while that prompt waits.
describe("continueRun against a plan", () => {
  const stopped = () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created" });
    return run.finish();
  };

  test("continues a run nothing touched", () => {
    const record = stopped();
    expect(() => continueRun(runsDir, record, 1).finish()).not.toThrow();
  });

  test("refuses a run an undo marked while it waited, and lets go of the lock", () => {
    const record = stopped();
    patchRun(runsDir, record.id, { status: "undone", undoneBy: "20260101-000000-abcd" });

    expect(() => continueRun(runsDir, record, 1)).toThrow(/changed while this import was waiting/);
    expect(fs.existsSync(lockFile(runsDir, record.id))).toBe(false);
    expect(readRun(runsDir, record.id)?.status).toBe("undone");
  });

  test("refuses a run another continue wrote to while it waited", () => {
    const record = stopped();
    fs.appendFileSync(
      path.join(runsDir, record.id, "users.ndjson"),
      `${JSON.stringify({ sourceId: "b", status: "created", clerkId: "user_b" })}\n`,
    );

    expect(() => continueRun(runsDir, record, 1)).toThrow(/changed while this import was waiting/);
  });
});

describe("continueRun and an unfinished undo", () => {
  // The caller checked before taking the lock; an undo can start, and stop
  // part-way, after that.
  test("refuses an import with an undo that did not finish, and leaves its record", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
    const record = run.finish();
    const undo = startRun(runsDir, { ...init, kind: "undo", undoes: record.id });
    undo.release();

    expect(() => continueRun(runsDir, record)).toThrow(/has an undo that did not finish/);
    expect(readRun(runsDir, record.id)).toMatchObject({
      status: record.status,
      finishedAt: record.finishedAt,
    });
    expect(fs.existsSync(lockFile(runsDir, record.id))).toBe(false);
  });
});

describe("listRuns", () => {
  test("lists newest first and ignores folders that are not runs", () => {
    const first = startRun(runsDir, init);
    first.update({ startedAt: "2026-01-01T00:00:00.000Z" });
    const second = startRun(runsDir, { ...init, kind: "export" });
    second.update({ startedAt: "2026-02-01T00:00:00.000Z" });
    fs.mkdirSync(path.join(runsDir, "not-a-run"));

    expect(listRuns(runsDir).map((record) => record.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
  });

  test("is empty when the folder does not exist", () => {
    expect(listRuns(path.join(workDir, "nowhere"))).toEqual([]);
  });
});
