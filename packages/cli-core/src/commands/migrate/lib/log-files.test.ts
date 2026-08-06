import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyLogFile, findLogFile, formatSize, listLogFiles, readNdjson } from "./log-files.ts";
import { getLogDir } from "./logger.ts";

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logfiles-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(getLogDir(), { recursive: true, force: true });
});

/** Writes a log file with one NDJSON line per entry. */
function writeLog(name: string, entries: unknown[]): string {
  fs.mkdirSync(getLogDir(), { recursive: true });
  const filePath = path.join(getLogDir(), name);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return filePath;
}

describe("classifyLogFile", () => {
  test.each([
    ["migration-2026-01-01T12-00-00.log", "migration", "2026-01-01T12-00-00"],
    ["user-deletion-2026-01-01T12-00-00.log", "deletion", "2026-01-01T12-00-00"],
    ["export-2026-01-01T12-00-00.log", "export", "2026-01-01T12-00-00"],
  ])("%s is a %s log from %s", (name, kind, timestamp) => {
    expect(classifyLogFile(name)).toEqual({ kind: kind as never, timestamp });
  });

  test.each([["random.log"], ["migration.log"], ["notes.txt"]])(
    "%s is unrecognized rather than a parse failure",
    (name) => {
      expect(classifyLogFile(name)).toEqual({ kind: "unknown", timestamp: "" });
    },
  );
});

describe("listLogFiles", () => {
  test("returns nothing when the directory does not exist", () => {
    expect(fs.existsSync(getLogDir())).toBe(false);
    expect(listLogFiles()).toEqual([]);
  });

  test("returns nothing when the directory is empty", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    expect(listLogFiles()).toEqual([]);
  });

  test("reports kind, timestamp, size and entry count per file", () => {
    writeLog("migration-2026-01-01T12-00-00.log", [{ userId: "u1" }, { userId: "u2" }]);

    const [file] = listLogFiles();
    expect(file).toMatchObject({
      name: "migration-2026-01-01T12-00-00.log",
      kind: "migration",
      timestamp: "2026-01-01T12-00-00",
      entryCount: 2,
    });
    expect(file?.sizeBytes).toBeGreaterThan(0);
  });

  test("ignores files that are not logs", () => {
    writeLog("migration-2026-01-01T12-00-00.log", [{ a: 1 }]);
    fs.writeFileSync(path.join(getLogDir(), "migration-2026-01-01T12-00-00.json"), "[]");
    fs.writeFileSync(path.join(getLogDir(), "notes.txt"), "hi");

    expect(listLogFiles().map((file) => file.name)).toEqual(["migration-2026-01-01T12-00-00.log"]);
  });

  test("ignores subdirectories", () => {
    fs.mkdirSync(path.join(getLogDir(), "nested.log"), { recursive: true });
    expect(listLogFiles()).toEqual([]);
  });

  test("returns the newest run first", () => {
    writeLog("migration-2026-01-01T12-00-00.log", [{ a: 1 }]);
    writeLog("migration-2026-03-01T12-00-00.log", [{ a: 1 }]);
    writeLog("migration-2026-02-01T12-00-00.log", [{ a: 1 }]);

    expect(listLogFiles().map((file) => file.timestamp)).toEqual([
      "2026-03-01T12-00-00",
      "2026-02-01T12-00-00",
      "2026-01-01T12-00-00",
    ]);
  });

  // Sorting on the filename would put every "user-deletion-" ahead of every
  // "migration-", regardless of when the runs actually happened.
  test("orders by timestamp across log kinds, not by the name's prefix", () => {
    writeLog("user-deletion-2026-01-30T17-02-51.log", [{ a: 1 }]);
    writeLog("migration-2026-02-01T09-14-22.log", [{ a: 1 }]);

    expect(listLogFiles().map((file) => file.kind)).toEqual(["migration", "deletion"]);
  });

  test("sorts unrecognized names last", () => {
    writeLog("something-else.log", [{ a: 1 }]);
    writeLog("migration-2026-01-01T12-00-00.log", [{ a: 1 }]);

    expect(listLogFiles().map((file) => file.name)).toEqual([
      "migration-2026-01-01T12-00-00.log",
      "something-else.log",
    ]);
  });

  test("does not count blank lines as entries", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    fs.writeFileSync(path.join(getLogDir(), "migration-x.log"), '{"a":1}\n\n\n{"b":2}\n');
    expect(listLogFiles()[0]?.entryCount).toBe(2);
  });

  test("lists a log whose name does not match the convention", () => {
    writeLog("something-else.log", [{ a: 1 }]);
    expect(listLogFiles()[0]).toMatchObject({ kind: "unknown", timestamp: "", entryCount: 1 });
  });
});

describe("findLogFile", () => {
  beforeEach(() => {
    writeLog("migration-2026-01-01T12-00-00.log", [{ a: 1 }]);
  });

  test("finds a log by name", () => {
    expect(findLogFile("migration-2026-01-01T12-00-00.log")?.entryCount).toBe(1);
  });

  test("accepts a path and matches on the basename", () => {
    expect(findLogFile("./logs/migration-2026-01-01T12-00-00.log")?.entryCount).toBe(1);
  });

  test("returns nothing for a name that is not there", () => {
    expect(findLogFile("migration-nope.log")).toBeUndefined();
  });
});

describe("readNdjson", () => {
  test("parses one entry per line", () => {
    const file = writeLog("migration-a.log", [{ userId: "u1" }, { userId: "u2" }]);
    const { entries, errors } = readNdjson(file);

    expect(entries).toEqual([{ userId: "u1" }, { userId: "u2" }]);
    expect(errors).toEqual([]);
  });

  test("skips blank lines without reporting them", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    const file = path.join(getLogDir(), "migration-b.log");
    fs.writeFileSync(file, '\n{"a":1}\n   \n{"b":2}\n\n');

    const { entries, errors } = readNdjson(file);
    expect(entries).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  // A run killed mid-write leaves one truncated line; the complete entries
  // before it are still worth having, so the read reports rather than aborts.
  test("reports a malformed line by number and keeps the rest", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    const file = path.join(getLogDir(), "migration-c.log");
    fs.writeFileSync(file, '{"a":1}\n{"b":\n{"c":3}\n');

    const { entries, errors } = readNdjson(file);
    expect(entries).toEqual([{ a: 1 }, { c: 3 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
  });

  test("numbers lines from one, counting blanks", () => {
    fs.mkdirSync(getLogDir(), { recursive: true });
    const file = path.join(getLogDir(), "migration-d.log");
    fs.writeFileSync(file, '\n\n{"a":1}\nnot json\n');

    expect(readNdjson(file).errors[0]?.line).toBe(4);
  });
});

describe("formatSize", () => {
  test.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024, "1.0 MB"],
  ])("%i bytes reads as %s", (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });
});
