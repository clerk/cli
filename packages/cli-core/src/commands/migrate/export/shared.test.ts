import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quoteArg } from "../../../lib/json-body.ts";
import { captureTelemetryPayload, useCaptureLog } from "../../../test/lib/stubs.ts";
import { readEnvelope } from "../lib/export-file.ts";
import { latestUserLines, readRun } from "../lib/run-store.ts";
import { finishExport, formatImportCommand, startExportRun } from "./shared.ts";

const captured = useCaptureLog();

let runsDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-export-shared-")));
  process.chdir(runsDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(runsDir, { recursive: true, force: true });
});

const users = [{ id: "u1", email: "a@x.dev" }];
const coverage = [{ label: "have an email address", count: 1 }];

describe("finishExport", () => {
  test("writes the envelope into the run folder by default", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });
    run.append({ sourceId: "u1", status: "exported" });

    const { record, outputPath } = finishExport({ run, options: {}, users, coverage });

    expect(outputPath).toBe(path.join(runsDir, record.id, "export.json"));
    expect(readEnvelope(outputPath)).toMatchObject({
      clerkMigrate: 1,
      source: "supabase",
      runId: record.id,
      users,
    });
    expect(readRun(runsDir, record.id)).toMatchObject({
      kind: "export",
      status: "complete",
      file: { path: outputPath },
    });
    expect(latestUserLines(runsDir, record.id).get("u1")?.status).toBe("exported");
  });

  // Exit code and --json are gone by the time someone imports the run.
  test("records a truncated export, and finishes it partial", async () => {
    const run = await startExportRun({ runsDir }, { platform: "auth0" });
    run.append({ sourceId: "u1", status: "exported" });

    const { record } = finishExport({ run, options: {}, users, coverage, truncated: true });

    expect(readRun(runsDir, record.id)).toMatchObject({ status: "partial", truncated: true });
  });

  // Padding and color codes belong to the terminal, not to --json.
  test("carries a section's items into --json as plain values", async () => {
    const run = await startExportRun({ runsDir }, { platform: "workos" });
    const sections = [{ title: "OAuth providers", items: [{ label: "GoogleOAuth", count: 2 }] }];

    finishExport({ run, options: { json: true }, users, coverage, sections });

    expect(JSON.parse(captured.out).sections).toEqual(sections);
    expect(captured.out).not.toContain("\u001b");
  });

  // The file holds password hashes and PII, so no other local account reads it.
  test("writes the file owner-only, in an owner-only run folder", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });

    const { outputPath } = finishExport({ run, options: {}, users, coverage });

    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(outputPath)).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing --output file to owner-only", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });
    const output = path.join(runsDir, "existing.json");
    fs.writeFileSync(output, "", { mode: 0o644 });

    const { outputPath } = finishExport({ run, options: { output }, users, coverage });

    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
  });

  // Written to a new file and renamed into place: a failed write leaves an
  // existing export as it was, and no half-written file behind.
  test("a failed write keeps an existing --output whole", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });
    const output = path.join(runsDir, "existing-before.json");
    fs.writeFileSync(output, "old", { mode: 0o600 });
    const write = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ) => {
      if (String(target).endsWith(".tmp")) {
        (write as (...args: unknown[]) => void)(target, "{ half", ...rest.slice(1));
        throw new Error("ENOSPC: no space left on device");
      }
      return (write as (...args: unknown[]) => void)(target, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => finishExport({ run, options: { output }, users, coverage })).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(output, "utf-8")).toBe("old");
    expect(fs.readdirSync(runsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // The run is left behind with every user's line but no file.
  test("a write that fails says where, and leaves no run behind", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });
    const output = path.join(runsDir, "a-directory.json");
    fs.mkdirSync(output);

    expect(() => finishExport({ run, options: { output }, users, coverage })).toThrow(
      new RegExp(`Could not write the export to ${output}: .*\\n.*with another --output`),
    );
    expect(fs.existsSync(run.dir)).toBe(false);
    expect(readRun(runsDir, run.record.id)).toBeUndefined();
  });

  // Import looks the run ID up in the runs folder it is given.
  test("the printed commands keep --runs-dir", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });

    finishExport({ run, options: { runsDir }, users, coverage });

    expect(captured.err).toContain(
      `clerk migrate import ${run.record.id} --runs-dir ${quoteArg(runsDir)}`,
    );
    expect(captured.err).toContain(
      `clerk migrate runs ${run.record.id} --runs-dir ${quoteArg(runsDir)}`,
    );
  });

  test("--json's next keeps --runs-dir, and counts the users skipped", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });
    run.append({ sourceId: "bad", status: "skipped", error: "no id" });

    finishExport({ run, options: { runsDir, json: true }, users, coverage });

    expect(JSON.parse(captured.out)).toMatchObject({
      next: `clerk migrate import ${run.record.id} --runs-dir ${quoteArg(runsDir)}`,
      skipped: 1,
    });
  });

  test("--output writes somewhere else, and the run still records where", async () => {
    const run = await startExportRun({ runsDir }, { platform: "auth0" });

    const { record, outputPath } = finishExport({
      run,
      options: { output: "mine/users.json" },
      users,
      coverage,
    });

    expect(outputPath).toBe(path.join(runsDir, "mine", "users.json"));
    expect(readRun(runsDir, record.id)?.file?.path).toBe(outputPath);
  });

  test("carries Firebase's hash parameters to the import", async () => {
    const run = await startExportRun({ runsDir }, { platform: "firebase" });
    const firebase = {
      base64_signer_key: "k",
      base64_salt_separator: "s",
      rounds: 8,
      mem_cost: 14,
    };

    const { outputPath } = finishExport({ run, options: {}, users, coverage, firebase });

    expect(readEnvelope(outputPath)?.firebase).toEqual(firebase);
  });

  // `truncated: true` alone is easy for an agent to miss.
  test("a truncated export exits 1, with its file still written", async () => {
    const run = await startExportRun({ runsDir }, { platform: "auth0" });
    try {
      const { outputPath } = finishExport({ run, options: {}, users, coverage, truncated: true });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(outputPath)).toBe(true);
    } finally {
      process.exitCode = 0;
    }
  });

  test("a finished export ends at done", async () => {
    const { payload } = await captureTelemetryPayload("migrate export auth0", async () => {
      const run = await startExportRun({ runsDir }, { platform: "auth0" });
      finishExport({ run, options: {}, users, coverage });
    });
    expect(payload).toMatchObject({ outcome: "success", stage: "done" });
  });

  test("a truncated export is coded", async () => {
    const { payload } = await captureTelemetryPayload("migrate export auth0", async () => {
      const run = await startExportRun({ runsDir }, { platform: "auth0" });
      finishExport({ run, options: {}, users, coverage, truncated: true });
    });
    expect(payload).toMatchObject({
      outcome: "error",
      stage: "done",
      error_code: "migrate_export_truncated",
    });
  });

  test("starting the export run records migrate_export_write", async () => {
    const { payload } = await captureTelemetryPayload("migrate export auth0", async () => {
      await startExportRun({ runsDir }, { platform: "auth0" });
    });
    expect(payload.stage).toBe("migrate_export_write");
  });

  test("prints the import command by run ID", async () => {
    const run = await startExportRun({ runsDir }, { platform: "clerk" });

    const { record } = finishExport({ run, options: {}, users, coverage });

    expect(captured.err).toContain(`clerk migrate import ${record.id}`);
  });

  test("--json returns the result on stdout instead", async () => {
    const run = await startExportRun({ runsDir }, { platform: "clerk" });

    const { record, outputPath } = finishExport({ run, options: { json: true }, users, coverage });

    expect(JSON.parse(captured.out)).toMatchObject({
      run: { id: record.id, kind: "export" },
      output: outputPath,
      users: 1,
      next: `clerk migrate import ${record.id}`,
    });
    expect(captured.err).not.toContain("Field coverage");
  });
});

describe("formatImportCommand", () => {
  const render = () => Bun.stripANSI(formatImportCommand("20260929-141502-a1b2").join("\n"));

  test("names the export run, which carries its own source", () => {
    expect(render()).toContain("clerk migrate import 20260929-141502-a1b2");
  });

  // The instance comes from the resolved key, so there is no flag whose
  // absence means development — the note says what actually decides.
  test("says how to reach production", () => {
    expect(render()).toContain("--instance prod");
  });
});
