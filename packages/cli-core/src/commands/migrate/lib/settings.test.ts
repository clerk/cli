import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir, getMigrationEntry, getProjectKey } from "../../../lib/config.ts";
import { loadSettings, saveSettings } from "./settings.ts";

let workDir: string;
let configDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  // Realpath'd because the project key is derived from `process.cwd()`, which
  // resolves the /var → /private/var symlink macOS puts in front of tmpdir.
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-settings-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-config-"));
  _setConfigDir(configDir);
});

afterEach(() => {
  _setConfigDir(undefined);
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("returns empty settings when nothing was saved", async () => {
  expect(await loadSettings()).toEqual({});
});

test("round-trips the transformer key and file path", async () => {
  await saveSettings({ transformer: "clerk", file: "users.json" });
  expect(await loadSettings()).toEqual({ transformer: "clerk", file: "users.json" });
});

test("writes to the CLI config file, not the working directory", async () => {
  await saveSettings({ transformer: "clerk" });

  expect(fs.existsSync(path.join(workDir, ".settings"))).toBe(false);
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
  expect(config.migrations).toEqual({ [await getProjectKey(workDir)]: { transformer: "clerk" } });
});

test("keys the record by project, so another directory does not see it", async () => {
  await saveSettings({ transformer: "clerk", file: "users.json" });

  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-other-")));
  try {
    expect(await getMigrationEntry(await getProjectKey(elsewhere))).toBeUndefined();
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("treats a corrupt config file as empty rather than failing the run", async () => {
  fs.writeFileSync(path.join(configDir, "config.json"), "{not json");
  expect(await loadSettings()).toEqual({});
});

test("leaves the run standing when the config cannot be written", async () => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.writeFileSync(configDir, "not a directory");

  await saveSettings({ transformer: "clerk" });
  expect(await loadSettings()).toEqual({});
});
