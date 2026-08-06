import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "./settings.ts";

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-settings-"));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(workDir, ".settings"), { force: true });
});

test("returns empty settings when the file is absent", () => {
  expect(loadSettings()).toEqual({});
});

test("round-trips the transformer key and file path", () => {
  saveSettings({ key: "clerk", file: "users.json" });
  expect(loadSettings()).toEqual({ key: "clerk", file: "users.json" });
});

test("writes to the current working directory", () => {
  saveSettings({ key: "clerk" });
  expect(fs.existsSync(path.join(workDir, ".settings"))).toBe(true);
});

test("treats a corrupt settings file as empty rather than failing the run", () => {
  fs.writeFileSync(path.join(workDir, ".settings"), "{not json");
  expect(loadSettings()).toEqual({});
});
