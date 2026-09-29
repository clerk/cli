import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../../lib/config.ts";
import {
  continueRun,
  latestUserLines,
  listRuns,
  newRunId,
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
    expect(runState(runsDir, run.record)).toBe("running");
  });

  test("finishes complete when every user made it", () => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created", clerkId: "user_a" });

    const record = run.finish();

    expect(record).toMatchObject({ status: "complete", counts: { total: 1, created: 1 } });
    expect(record.finishedAt).toBeDefined();
    expect(fs.existsSync(path.join(run.dir, "lock"))).toBe(false);
  });

  test.each([["failed"], ["skipped"]] as const)("finishes partial when a user was %s", (status) => {
    const run = startRun(runsDir, init);
    run.append({ sourceId: "a", status: "created" });
    run.append({ sourceId: "b", status });
    expect(run.finish().status).toBe("partial");
  });

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

  test("refuses a run another live process holds, with exit 2", () => {
    const run = startRun(runsDir, init);
    // PID 1 is always alive, and never this test.
    fs.writeFileSync(path.join(run.dir, "lock"), "1");

    expect(() => continueRun(runsDir, run.record)).toThrow(/in use by another process \(PID 1\)/);
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
