import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { getLogDir } from "../lib/logger.ts";
import { clean } from "./clean.ts";
import { convert } from "./convert.ts";
import { list } from "./list.ts";

const captured = useCaptureLog();

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logs-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(getLogDir(), { recursive: true, force: true });
  process.exitCode = 0;
});

function writeLog(name: string, entries: unknown[]): void {
  fs.mkdirSync(getLogDir(), { recursive: true });
  fs.writeFileSync(
    path.join(getLogDir(), name),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

const MIGRATION = "migration-2026-01-01T12-00-00.log";
const DELETION = "user-deletion-2026-02-01T12-00-00.log";

describe("logs list", () => {
  test("says so plainly when there is no logs directory", () => {
    list();
    expect(captured.err).toContain("No migration logs in");
  });

  test("says so plainly when the directory is empty", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    list();
    expect(captured.err).toContain("No migration logs in");
  });

  test("reports type, timestamp, size and entry count", () => {
    writeLog(MIGRATION, [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }]);

    list();

    expect(captured.err).toContain("TYPE");
    expect(captured.err).toContain("TIMESTAMP");
    expect(captured.err).toContain("SIZE");
    expect(captured.err).toContain("ENTRIES");
    expect(captured.err).toContain("migration");
    expect(captured.err).toContain("2026-01-01T12-00-00");
    expect(captured.err).toMatch(/\bB\b/);
    expect(captured.err).toContain("3");
  });

  test("lists every log kind", () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ a: 1 }]);

    list();

    expect(captured.err).toContain("migration");
    expect(captured.err).toContain("deletion");
    expect(captured.err).toContain("2 log files");
  });

  test("--json emits a machine-readable listing on stdout", () => {
    writeLog(MIGRATION, [{ userId: "u1" }]);

    list({ json: true });

    const parsed = JSON.parse(captured.out) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: MIGRATION,
      kind: "migration",
      timestamp: "2026-01-01T12-00-00",
      entry_count: 1,
    });
  });

  test("--json emits an empty array rather than prose when there are no logs", () => {
    list({ json: true });
    expect(JSON.parse(captured.out)).toEqual([]);
  });
});

describe("logs clean", () => {
  test("says so plainly when there is nothing to clean", async () => {
    await clean({ yes: true });
    expect(captured.err).toContain("No migration logs to clean");
  });

  // Tests run non-TTY, which is the same signal an agent gives.
  test("refuses without -y when it cannot prompt, and explains", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await expect(clean()).rejects.toThrow(/cannot prompt here.*Pass -y/s);
    expect(fs.existsSync(path.join(getLogDir(), MIGRATION))).toBe(true);
  });

  test("names how many files are at stake when it refuses", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ a: 1 }]);

    await expect(clean()).rejects.toThrow(/2 log files/);
  });

  test("-y deletes the log files and reports the count", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ a: 1 }]);

    await clean({ yes: true });

    expect(fs.readdirSync(getLogDir())).toEqual([]);
    expect(captured.err).toContain("Deleted 2 log files");
  });

  test("leaves converted JSON output alone", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    fs.writeFileSync(path.join(getLogDir(), "migration-2026-01-01T12-00-00.json"), "[]");

    await clean({ yes: true });

    expect(fs.readdirSync(getLogDir())).toEqual(["migration-2026-01-01T12-00-00.json"]);
  });
});

describe("logs convert", () => {
  test("says so plainly when there is nothing to convert", async () => {
    await convert({ all: true });
    expect(captured.err).toContain("No migration logs to convert");
  });

  test("writes a JSON array alongside the original, leaving it intact", async () => {
    writeLog(MIGRATION, [{ userId: "u1" }, { userId: "u2" }]);

    await convert({ files: [MIGRATION] });

    const output = path.join(getLogDir(), "migration-2026-01-01T12-00-00.json");
    expect(JSON.parse(fs.readFileSync(output, "utf-8"))).toEqual([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    expect(fs.existsSync(path.join(getLogDir(), MIGRATION))).toBe(true);
    expect(captured.err).toContain("Originals left in place");
  });

  test("--all converts every log file", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ b: 2 }]);

    await convert({ all: true });

    const written = fs.readdirSync(getLogDir()).filter((name) => name.endsWith(".json"));
    expect(written.sort()).toEqual([
      "migration-2026-01-01T12-00-00.json",
      "user-deletion-2026-02-01T12-00-00.json",
    ]);
  });

  test("accepts a path and resolves it against ./logs/", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await convert({ files: [`./logs/${MIGRATION}`] });

    expect(fs.existsSync(path.join(getLogDir(), "migration-2026-01-01T12-00-00.json"))).toBe(true);
  });

  test("fails clearly on a file that is not there", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await expect(convert({ files: ["migration-nope.log"] })).rejects.toThrow(CliError);
  });

  // Silently dropping the line would leave a JSON array that looks complete.
  test("reports a malformed line by number and converts the rest", async () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    fs.writeFileSync(path.join(getLogDir(), MIGRATION), '{"a":1}\n{"b":\n{"c":3}\n');

    await convert({ files: [MIGRATION] });

    expect(captured.err).toContain(`${MIGRATION}:2`);
    expect(captured.err).toContain("1 malformed line skipped");

    const output = path.join(getLogDir(), "migration-2026-01-01T12-00-00.json");
    expect(JSON.parse(fs.readFileSync(output, "utf-8"))).toEqual([{ a: 1 }, { c: 3 }]);
  });

  test("refuses without a target when it cannot prompt, naming the alternatives", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await expect(convert()).rejects.toThrow(/cannot prompt here/);
    expect(fs.readdirSync(getLogDir())).toEqual([MIGRATION]);
  });

  test("reports the entry count per converted file", async () => {
    writeLog(MIGRATION, [{ a: 1 }, { b: 2 }, { c: 3 }]);

    await convert({ all: true });

    expect(captured.err).toContain("3 entries");
  });
});
