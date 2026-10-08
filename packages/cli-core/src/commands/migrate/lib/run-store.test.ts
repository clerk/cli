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
  latestUserLines,
  liveLockPid,
  newRunId,
  readRun,
  resolveRunsDir,
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

  // A user created with no line is beyond both undo and a re-run, so the
  // create that would follow must not go out.
  test("append throws when the line cannot be written", () => {
    const run = startRun(runsDir, init);
    fs.mkdirSync(path.join(run.dir, "users.ndjson"));

    expect(() => run.append({ sourceId: "a", status: "creating" })).toThrow();
  });
});

describe("locks", () => {
  test("a lock whose process died is stale", () => {
    const run = startRun(runsDir, init);
    // A PID no process can have.
    fs.writeFileSync(path.join(run.dir, "lock"), "2147483646");
    expect(liveLockPid(runsDir, run.record.id)).toBeUndefined();
  });

  // In a container the CLI often gets the same PID every run, so a killed
  // run's lock can hold this process's own PID.
  test("a lock holding this process's own PID is stale", () => {
    const run = startRun(runsDir, init);
    expect(liveLockPid(runsDir, run.record.id)).toBeUndefined();
  });

  test("a lock another live process holds is live", () => {
    const run = startRun(runsDir, init);
    // PID 1 is always alive, and never this test.
    fs.writeFileSync(path.join(run.dir, "lock"), "1");
    expect(liveLockPid(runsDir, run.record.id)).toBe(1);
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
    expect(stopped.finish({ notSent: 2 }).status).toBe("partial");
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
});
