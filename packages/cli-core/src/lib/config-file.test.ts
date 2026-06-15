import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_PRECEDENCE, resolveConfigFile } from "./config-file.ts";

function makeClerkDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "clerk-cfg-"));
  mkdirSync(join(dir, ".clerk"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}

describe("resolveConfigFile", () => {
  test("precedence list is yaml, yml, json", () => {
    expect(CONFIG_FILE_PRECEDENCE).toEqual([
      ".clerk/config.yaml",
      ".clerk/config.yml",
      ".clerk/config.json",
    ]);
  });

  test("prefers yaml over json when both exist", async () => {
    const dir = makeClerkDir([".clerk/config.yaml", ".clerk/config.json"]);
    expect(await resolveConfigFile(dir)).toBe(join(dir, ".clerk/config.yaml"));
  });

  test("falls back to json when only json exists", async () => {
    const dir = makeClerkDir([".clerk/config.json"]);
    expect(await resolveConfigFile(dir)).toBe(join(dir, ".clerk/config.json"));
  });

  test("returns undefined when no config file exists", async () => {
    const dir = makeClerkDir([]);
    expect(await resolveConfigFile(dir)).toBeUndefined();
  });
});
