import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  errorLogger,
  getDateTimeStamp,
  getLogDir,
  getLogFilePath,
  importLogger,
  validationLogger,
} from "./logger.ts";

const DATE_TIME = "2026-01-01T12:00:00";

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  // realpath so the comparison against process.cwd() survives macOS's
  // /var -> /private/var symlink.
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logger-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(getLogDir(), { recursive: true, force: true });
});

function readEntries(): Record<string, unknown>[] {
  return fs
    .readFileSync(getLogFilePath("import", DATE_TIME), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("log file paths", () => {
  test("writes under the current working directory, not next to the binary", () => {
    expect(getLogDir()).toBe(path.join(workDir, "logs"));
  });

  test("replaces the timestamp's colons so the name is valid on Windows", () => {
    expect(path.basename(getLogFilePath("import", DATE_TIME))).toBe(
      "import-2026-01-01T12-00-00.log",
    );
  });

  test("getDateTimeStamp drops milliseconds", () => {
    expect(getDateTimeStamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("log writers", () => {
  test("creates the logs directory on first write", () => {
    expect(fs.existsSync(getLogDir())).toBe(false);
    importLogger({ userId: "u1", status: "success", clerkUserId: "user_x" }, DATE_TIME);
    expect(fs.existsSync(getLogDir())).toBe(true);
  });

  test("appends one NDJSON line per entry", () => {
    importLogger({ userId: "u1", status: "success", clerkUserId: "user_x" }, DATE_TIME);
    importLogger({ userId: "u2", status: "error", error: "boom", code: "422" }, DATE_TIME);

    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ userId: "u1", status: "success", clerkUserId: "user_x" });
    expect(entries[1]).toEqual({ userId: "u2", status: "error", error: "boom", code: "422" });
  });

  test("writes one line per error in a failed payload", () => {
    errorLogger(
      {
        userId: "u1",
        status: "422",
        errors: [
          { code: "a", message: "short a", longMessage: "long a" },
          { code: "b", message: "short b" },
        ],
      },
      DATE_TIME,
    );

    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "User Creation Error", error: "long a" });
    // Falls back to `message` when the API omitted a long form.
    expect(entries[1]).toMatchObject({ error: "short b" });
  });

  test("records validation failures in the same run log", () => {
    validationLogger(
      { error: "missing identifier", path: ["email"], userId: "u3", row: 4 },
      DATE_TIME,
    );
    expect(readEntries()[0]).toEqual({
      userId: "u3",
      status: "fail",
      error: "missing identifier",
      path: ["email"],
      row: 4,
    });
  });
});
