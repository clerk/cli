import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { startRun } from "./lib/run-store.ts";
import { runs } from "./runs.ts";

const captured = useCaptureLog();

let runsDir: string;

beforeEach(() => {
  runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-runs-")));
});

afterEach(() => {
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function partialImport() {
  const run = startRun(runsDir, {
    kind: "import",
    target: { appLabel: "My App", env: "development", instanceId: "ins_1" },
    source: "clerk",
    file: { path: "/tmp/users.json", sha256: "abc" },
  });
  run.append({ sourceId: "a", status: "created", clerkId: "user_a" });
  run.append({ sourceId: "b", status: "failed", error: "That email address is taken." });
  run.append({ sourceId: "c", status: "failed", error: "That email address is taken." });
  run.append({ sourceId: "d", status: "skipped", reason: "no password (--require-password)" });
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

  test("an unknown ID is a usage error", async () => {
    await expect(runs("nope", { runsDir })).rejects.toThrow(/No run `nope`/);
  });
});
