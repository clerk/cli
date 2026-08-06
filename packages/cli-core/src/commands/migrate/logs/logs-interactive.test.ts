/**
 * The prompting half of `logs clean` and `logs convert`.
 *
 * Kept separate because `mock.module` registrations are process-lifetime, and
 * `bun test --parallel` puts several files in each worker — so a mocked
 * `prompts.ts` would leak into any file that later lands in the same worker and
 * imports the real one. Human mode itself needs no mock: `setMode` is the
 * supported override.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

type ConfirmPrompt = { message: string; default?: boolean };
type MultiselectPrompt = {
  message: string;
  options: { value: string; label: string; hint?: string }[];
};

const mockConfirm = mock(async (_config: ConfirmPrompt) => true);
const mockMultiselect = mock(async (_config: MultiselectPrompt) => [] as string[]);

mock.module("../../../lib/prompts.ts", () => ({
  confirm: (config: ConfirmPrompt) => mockConfirm(config),
  multiselect: (config: MultiselectPrompt) => mockMultiselect(config),
  text: async () => "",
  password: async () => "",
  editor: async () => "{}",
}));

const { clean } = await import("./clean.ts");
const { convert } = await import("./convert.ts");
const { UserAbortError } = await import("../../../lib/errors.ts");
const { getLogDir } = await import("../lib/logger.ts");

let originalMode: Mode;

const captured = useCaptureLog();

let workDir: string;
let originalCwd: string;

const MIGRATION = "migration-2026-01-01T12-00-00.log";
const DELETION = "user-deletion-2026-02-01T12-00-00.log";

beforeAll(() => {
  originalMode = getMode();
  setMode("human");
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-logs-int-")));
  process.chdir(workDir);
});

afterAll(() => {
  setMode(originalMode);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockConfirm.mockReset();
  mockMultiselect.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockMultiselect.mockResolvedValue([]);
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

describe("logs clean", () => {
  test("prompts before deleting anything", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ a: 1 }]);

    await clean();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm.mock.calls[0]?.[0]?.message).toContain("2 log files");
    expect(fs.readdirSync(getLogDir())).toEqual([]);
  });

  // Deleting on a stray enter would be the wrong default for a destructive
  // command sitting next to `clerk migrate delete`.
  test("defaults the prompt to no", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await clean();

    expect(mockConfirm.mock.calls[0]?.[0]?.default).toBe(false);
  });

  test("declining leaves every file in place", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    mockConfirm.mockResolvedValue(false);

    await expect(clean()).rejects.toThrow(UserAbortError);

    expect(fs.readdirSync(getLogDir())).toEqual([MIGRATION]);
  });

  test("-y skips the prompt entirely", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await clean({ yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(fs.readdirSync(getLogDir())).toEqual([]);
  });

  test("does not prompt when there is nothing to delete", async () => {
    await clean();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe("logs convert", () => {
  test("offers a multiselect when given neither files nor --all", async () => {
    writeLog(MIGRATION, [{ a: 1 }, { b: 2 }]);
    writeLog(DELETION, [{ a: 1 }]);
    mockMultiselect.mockResolvedValue([MIGRATION]);

    await convert();

    const options = mockMultiselect.mock.calls[0]?.[0]?.options;
    expect(options?.map((option) => option.value)).toEqual([DELETION, MIGRATION]);
    expect(options?.[1]?.hint).toBe("2 entries");
  });

  test("converts only what was selected", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    writeLog(DELETION, [{ a: 1 }]);
    mockMultiselect.mockResolvedValue([MIGRATION]);

    await convert();

    expect(fs.readdirSync(getLogDir()).filter((name) => name.endsWith(".json"))).toEqual([
      "migration-2026-01-01T12-00-00.json",
    ]);
  });

  test("selecting nothing aborts without writing", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);
    mockMultiselect.mockResolvedValue([]);

    await expect(convert()).rejects.toThrow(UserAbortError);

    expect(fs.readdirSync(getLogDir())).toEqual([MIGRATION]);
  });

  test("does not prompt when --all was passed", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await convert({ all: true });

    expect(mockMultiselect).not.toHaveBeenCalled();
    expect(captured.err).toContain("Converted 1 log file");
  });

  test("does not prompt when files were named", async () => {
    writeLog(MIGRATION, [{ a: 1 }]);

    await convert({ files: [MIGRATION] });

    expect(mockMultiselect).not.toHaveBeenCalled();
  });
});
