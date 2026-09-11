/**
 * The one path `logger.test.ts` cannot cover: `ensureLogDir` actually asking.
 *
 * Its own file because `mock.module` registrations last for the process, and
 * `bun test --parallel` puts several files in each worker — a mocked
 * `prompts.ts` would leak into any file that later lands in the same worker and
 * imports the real one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../../lib/config.ts";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

type TextConfig = { message: string; default?: string; placeholder?: string };

let answer = "";
const mockText = mock(async (_config: TextConfig) => answer);

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../../lib/prompts.ts", () => ({
  text: (...args: unknown[]) => mockText(...(args as [TextConfig])),
  confirm: async () => true,
  multiselect: async () => [],
  password: async () => "",
  editor: async () => "{}",
}));

const { _resetLogDir, ensureLogDir } = await import("./logger.ts");
const { loadSettings, saveSettings } = await import("./settings.ts");

useCaptureLog();

let workDir: string;
let configDir: string;
let originalCwd: string;
let originalMode: Mode;
let originalEnv: string | undefined;

beforeAll(() => {
  originalCwd = process.cwd();
  originalMode = getMode();
  originalEnv = process.env.CLERK_MIGRATE_LOG_DIR;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logdir-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logdir-cfg-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  setMode(originalMode);
  if (originalEnv === undefined) delete process.env.CLERK_MIGRATE_LOG_DIR;
  else process.env.CLERK_MIGRATE_LOG_DIR = originalEnv;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetLogDir();
  delete process.env.CLERK_MIGRATE_LOG_DIR;
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  mockText.mockClear();
  answer = "";
  setMode("human");
});

afterEach(() => _resetLogDir());

describe("ensureLogDir asks once", () => {
  test("saves the answer, so the next run does not ask", async () => {
    answer = "./migration-logs";

    expect(await ensureLogDir()).toBe(path.join(workDir, "migration-logs"));
    expect(await loadSettings()).toMatchObject({ logDir: "./migration-logs" });

    _resetLogDir();
    expect(await ensureLogDir()).toBe(path.join(workDir, "migration-logs"));
    expect(mockText).toHaveBeenCalledTimes(1);
  });

  test("offers ./logs as the default", async () => {
    await ensureLogDir();
    expect(mockText.mock.calls[0]?.[0]).toMatchObject({ default: "./logs" });
  });

  // Enter on the prompt is an answer, not a skip: it settles the question so
  // the next run goes straight to importing.
  test("treats an empty answer as ./logs and remembers it", async () => {
    answer = "   ";

    expect(await ensureLogDir()).toBe(path.join(workDir, "logs"));
    expect(await loadSettings()).toMatchObject({ logDir: "./logs" });
  });

  test("leaves the project's other settings alone", async () => {
    await saveSettings({ transformer: "firebase", file: "users.json" });
    answer = "./audit";

    await ensureLogDir();

    expect(await loadSettings()).toEqual({
      transformer: "firebase",
      file: "users.json",
      logDir: "./audit",
    });
  });
});
