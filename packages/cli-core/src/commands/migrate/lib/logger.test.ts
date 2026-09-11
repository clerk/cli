import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetLogDir,
  DEFAULT_LOG_DIR,
  ensureLogDir,
  errorLogger,
  getDateTimeStamp,
  getLogDir,
  getLogFilePath,
  importLogger,
  resolveLogDir,
  validationLogger,
} from "./logger.ts";
import { _setConfigDir } from "../../../lib/config.ts";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { MIGRATE_ENV_FILE } from "./env-file.ts";
import { loadSettings, saveSettings } from "./settings.ts";

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
  _resetLogDir();
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

describe("resolving the log directory", () => {
  let configDir: string;
  let originalMode: Mode;
  let originalEnv: string | undefined;

  beforeAll(() => {
    originalMode = getMode();
    originalEnv = process.env.CLERK_MIGRATE_LOG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logdir-cfg-"));
    _setConfigDir(configDir);
  });

  afterAll(() => {
    setMode(originalMode);
    if (originalEnv === undefined) delete process.env.CLERK_MIGRATE_LOG_DIR;
    else process.env.CLERK_MIGRATE_LOG_DIR = originalEnv;
    _setConfigDir(undefined);
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.CLERK_MIGRATE_LOG_DIR;
    fs.rmSync(path.join(configDir, "config.json"), { force: true });
    fs.rmSync(path.join(workDir, MIGRATE_ENV_FILE), { force: true });
    setMode("agent");
  });

  test("falls back to ./logs when nothing has chosen one", async () => {
    expect(await resolveLogDir()).toBe(path.join(workDir, "logs"));
  });

  test("prefers the saved setting over the default", async () => {
    await saveSettings({ logDir: "./audit" });
    expect(await resolveLogDir()).toBe(path.join(workDir, "audit"));
  });

  // A variable exported for one shell is the narrower statement of the two.
  test("prefers the environment over the saved setting", async () => {
    await saveSettings({ logDir: "./audit" });
    process.env.CLERK_MIGRATE_LOG_DIR = "./from-env";

    expect(await resolveLogDir()).toBe(path.join(workDir, "from-env"));
  });

  test("reads the migration's own env file", async () => {
    fs.writeFileSync(path.join(workDir, MIGRATE_ENV_FILE), "CLERK_MIGRATE_LOG_DIR=./from-file\n");
    expect(await resolveLogDir()).toBe(path.join(workDir, "from-file"));
  });

  // Every synchronous write reads the settled value, so resolving is what makes
  // the log files land anywhere but ./logs.
  test("settles the directory the log writers use", async () => {
    await saveSettings({ logDir: "./audit" });
    await resolveLogDir();

    expect(getLogFilePath("import", DATE_TIME)).toBe(
      path.join(workDir, "audit", `import-${DATE_TIME.replace(/:/g, "-")}.log`),
    );
  });

  describe("ensureLogDir", () => {
    test("takes the default without saving it when nobody can be asked", async () => {
      expect(await ensureLogDir()).toBe(path.join(workDir, DEFAULT_LOG_DIR));
      // Nothing saved: the question stays open for the first interactive run.
      expect(await loadSettings()).toEqual({});
    });

    test("does not ask once the setting is saved", async () => {
      await saveSettings({ logDir: "./audit" });
      setMode("human");

      // Reaching the prompt in a test without a TTY throws, so returning is the
      // assertion.
      expect(await ensureLogDir()).toBe(path.join(workDir, "audit"));
    });

    test("does not ask when the environment already answers", async () => {
      process.env.CLERK_MIGRATE_LOG_DIR = "./from-env";
      setMode("human");

      expect(await ensureLogDir()).toBe(path.join(workDir, "from-env"));
      expect(await loadSettings()).toEqual({});
    });
  });
});
