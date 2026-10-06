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

const { promptForFile, promptForFirebaseHashConfig, promptForSource } = await import("./wizard.ts");

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-wizard-")));
  process.chdir(workDir);
  fs.writeFileSync(path.join(workDir, "users.json"), "[]");
  fs.writeFileSync(path.join(workDir, "other.csv"), "");
  fs.writeFileSync(path.join(workDir, "notes.txt"), "");
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockSelect.mockReset();
  mockText.mockReset();
});

/** The config object passed to the Nth `text`/`select` prompt. */
const textCall = (index: number): Prompt | undefined => mockText.mock.calls[index]?.[0];
const selectCall = (index: number): SelectPrompt | undefined => mockSelect.mock.calls[index]?.[0];

describe("promptForSource", () => {
  test("is built from the registry, so every platform appears", async () => {
    mockSelect.mockResolvedValue("supabase");

    expect(await promptForSource()).toBe("supabase");
    expect(selectCall(0)?.choices.map((choice) => choice.value)).toEqual([
      "clerk",
      "firebase",
      "supabase",
    ]);
  });

  test("labels each choice with the source's display name", async () => {
    mockSelect.mockResolvedValue("clerk");
    await promptForSource();
    expect(selectCall(0)?.choices.map((choice) => choice.name)).toContain("Supabase");
  });
});

describe("promptForFile", () => {
  const validate = async () => {
    mockText.mockResolvedValue("users.json");
    await promptForFile();
    return textCall(0)?.validate as (value?: string) => string | undefined;
  };

  test("returns the trimmed path", async () => {
    mockText.mockResolvedValue("  users.json  ");
    expect(await promptForFile()).toBe("users.json");
  });

  test("accepts an existing JSON or CSV file", async () => {
    const check = await validate();
    expect(check("users.json")).toBeUndefined();
    expect(check("other.csv")).toBeUndefined();
  });

  test.each([
    ["", /required/],
    ["nope.json", /File not found/],
    ["notes.txt", /\.json or \.csv/],
  ])("rejects %p", async (value, message) => {
    const check = await validate();
    expect(check(value)).toMatch(message);
  });
});

describe("promptForFirebaseHashConfig", () => {
  test("collects all four parameters as a set", async () => {
    mockText
      .mockResolvedValueOnce("SIGNER")
      .mockResolvedValueOnce("Bw==")
      .mockResolvedValueOnce("8")
      .mockResolvedValueOnce("14");

    expect(await promptForFirebaseHashConfig()).toEqual({
      base64_signer_key: "SIGNER",
      base64_salt_separator: "Bw==",
      rounds: 8,
      mem_cost: 14,
    });
  });

  // An export with no password hashes needs none of them.
  test("stops when the signer key is left blank", async () => {
    mockText.mockResolvedValueOnce("");

    expect(await promptForFirebaseHashConfig()).toBeUndefined();
    expect(mockText).toHaveBeenCalledTimes(1);
  });
});
