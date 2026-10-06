import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
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

  // The file holds password hashes and PII, so no other local account reads it.
  test("writes the file owner-only, in an owner-only run folder", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });

    const { outputPath } = finishExport({ run, options: {}, users, coverage });

    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(outputPath)).mode & 0o777).toBe(0o700);
  });

  test("--output writes somewhere else, and the run still records where", async () => {
    const run = await startExportRun({ runsDir }, { platform: "supabase" });

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
