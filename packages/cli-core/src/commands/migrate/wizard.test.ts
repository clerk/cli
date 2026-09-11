import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listageStubs, useCaptureLog } from "../../test/lib/stubs.ts";

useCaptureLog();

type Prompt = { message: string; default?: string; validate?: (v?: string) => string | undefined };
type SelectPrompt = Prompt & { choices: { name: string; value: string }[] };

// Registered at file top, before the wizard (or anything it imports) loads.
// This file is the only consumer of the mocked prompt modules.
const mockSelect = mock(async (_config: SelectPrompt) => undefined as unknown);
const mockText = mock(async (_config: Prompt) => "" as unknown);

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (config: SelectPrompt) => mockSelect(config),
}));

mock.module("../../lib/prompts.ts", () => ({
  confirm: async () => true,
  text: (config: Prompt) => mockText(config),
  password: async () => "",
  editor: async () => "{}",
}));

const { runWizard, throwAgentFlagsRequired } = await import("./wizard.ts");
const { saveSettings } = await import("./lib/settings.ts");
const { _setConfigDir } = await import("../../lib/config.ts");

let workDir: string;
let configDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-wizard-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-wizard-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
  fs.writeFileSync(path.join(workDir, "users.json"), "[]");
  fs.writeFileSync(path.join(workDir, "other.csv"), "");
});

afterAll(() => {
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockSelect.mockReset();
  mockText.mockReset();
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
});

/** The config object the wizard passed to its Nth `text`/`select` prompt. */
const textCall = (index: number): Prompt | undefined => mockText.mock.calls[index]?.[0];
const selectCall = (index: number): SelectPrompt | undefined => mockSelect.mock.calls[index]?.[0];

describe("transformer picker", () => {
  test("is built from the registry, so every platform appears", async () => {
    mockSelect.mockResolvedValue("auth0");
    mockText.mockResolvedValue("users.json");

    await runWizard({});

    expect(selectCall(0)?.choices.map((choice) => choice.value)).toEqual([
      "clerk",
      "auth0",
      "authjs",
      "betterauth",
      "firebase",
      "supabase",
    ]);
  });

  test("labels each choice with the transformer's display name", async () => {
    mockSelect.mockResolvedValue("clerk");
    mockText.mockResolvedValue("users.json");

    await runWizard({});

    expect(selectCall(0)?.choices.map((choice) => choice.name)).toContain("Better Auth");
  });

  test("is skipped when --transformer was already passed", async () => {
    mockText.mockResolvedValue("users.json");

    const result = await runWizard({ transformer: "clerk" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(result.transformer).toBe("clerk");
  });
});

describe("defaults from the previous run", () => {
  test("pre-selects the last transformer and pre-fills the last file", async () => {
    await saveSettings({ transformer: "supabase", file: "other.csv" });
    mockSelect.mockResolvedValue("supabase");
    mockText.mockResolvedValue("other.csv");

    await runWizard({});

    expect(selectCall(0)?.default).toBe("supabase");
    expect(textCall(0)?.default).toBe("other.csv");
  });

  test("offers no default when nothing has been saved", async () => {
    mockSelect.mockResolvedValue("clerk");
    mockText.mockResolvedValue("users.json");

    await runWizard({});

    expect(selectCall(0)?.default).toBeUndefined();
    expect(textCall(0)?.default).toBeUndefined();
  });

  // A saved key from a build that has since dropped that transformer would
  // otherwise pre-select a value the picker cannot offer.
  test("ignores a saved transformer that is no longer registered", async () => {
    await saveSettings({ transformer: "okta" });
    mockSelect.mockResolvedValue("clerk");
    mockText.mockResolvedValue("users.json");

    await runWizard({});

    expect(selectCall(0)?.default).toBeUndefined();
  });
});

describe("file prompt validation", () => {
  const validate = async () => {
    mockSelect.mockResolvedValue("clerk");
    mockText.mockResolvedValue("users.json");
    await runWizard({});
    return textCall(0)?.validate;
  };

  test.each([
    ["users.json", undefined],
    ["other.csv", undefined],
  ])("accepts %s", async (file, expected) => {
    expect((await validate())?.(file)).toBe(expected as undefined);
  });

  test("rejects an empty answer", async () => {
    expect((await validate())?.("")).toMatch(/required/);
  });

  test("rejects a file that does not exist", async () => {
    expect((await validate())?.("missing.json")).toMatch(/File not found/);
  });

  test("rejects an unsupported extension", async () => {
    fs.writeFileSync(path.join(workDir, "notes.txt"), "");
    expect((await validate())?.("notes.txt")).toMatch(/\.json or \.csv/);
  });
});

describe("firebase hash parameters", () => {
  test("are asked for when the firebase transformer is picked", async () => {
    mockSelect.mockResolvedValue("firebase");
    mockText
      .mockResolvedValueOnce("users.json")
      .mockResolvedValueOnce("SIGNER")
      .mockResolvedValueOnce("Bw==")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("14");

    const result = await runWizard({});

    expect(result.firebaseHashConfig).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  // Pressing enter through the signer key is how a user says "this export has
  // no passwords" — the remaining three would be meaningless without it.
  test("stop being asked when the signer key is left blank", async () => {
    mockSelect.mockResolvedValue("firebase");
    mockText.mockResolvedValueOnce("users.json").mockResolvedValueOnce("  ");

    const result = await runWizard({});

    expect(result.firebaseHashConfig).toBeUndefined();
    expect(mockText).toHaveBeenCalledTimes(2);
  });

  // The signer key is a Firebase secret, so it is never written to disk and so
  // there is nothing to offer back. A repeat run passes it as a flag or env var.
  test("are never pre-filled, because they are not saved", async () => {
    mockSelect.mockResolvedValue("firebase");
    mockText
      .mockResolvedValueOnce("users.json")
      .mockResolvedValueOnce("SIGNER")
      .mockResolvedValueOnce("Bw==")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("14");

    await runWizard({});

    expect(textCall(1)?.default).toBeUndefined();
    expect(textCall(3)?.default).toBeUndefined();
  });

  test("are not asked for on a non-firebase transformer", async () => {
    mockSelect.mockResolvedValue("auth0");
    mockText.mockResolvedValue("users.json");

    await runWizard({});

    expect(mockText).toHaveBeenCalledTimes(1);
  });

  test("are not asked for when the flags already supplied them", async () => {
    mockSelect.mockResolvedValue("firebase");
    mockText.mockResolvedValue("users.json");

    const config = {
      base64_signer_key: "FLAG",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    };
    const result = await runWizard({ firebaseHashConfig: config });

    expect(mockText).toHaveBeenCalledTimes(1);
    expect(result.firebaseHashConfig).toEqual(config);
  });

  test.each([["0"], ["-1"], ["1.5"], ["many"]])("rejects %p as a rounds value", async (value) => {
    mockSelect.mockResolvedValue("firebase");
    mockText
      .mockResolvedValueOnce("users.json")
      .mockResolvedValueOnce("SIGNER")
      .mockResolvedValueOnce("Bw==")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("14");

    await runWizard({});

    expect(textCall(3)?.validate?.(value)).toMatch(/positive whole number/);
  });
});

describe("throwAgentFlagsRequired", () => {
  test.each([
    [{ transformer: true, file: true }, /--transformer <platform> and --file <path>/],
    [{ transformer: true, file: false }, /--transformer <platform>\./],
    [{ transformer: false, file: true }, /--file <path>\./],
  ])("names only the flags that are missing (%p)", (missing, expected) => {
    expect(() => throwAgentFlagsRequired(missing)).toThrow(expected);
  });

  test("says why it cannot prompt", () => {
    expect(() => throwAgentFlagsRequired({ transformer: true, file: true })).toThrow(
      /cannot prompt in agent mode/,
    );
  });
});
