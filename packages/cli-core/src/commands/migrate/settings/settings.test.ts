import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _setConfigDir } from "../../../lib/config.ts";
import { setMode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { MIGRATE_ENV_FILE } from "../lib/env-file.ts";
import { loadSettings, saveSettings } from "../lib/settings.ts";
import { clear } from "./clear.ts";
import { list } from "./list.ts";
import { displayValue, findSetting } from "./registry.ts";
import { set } from "./set.ts";

const captured = useCaptureLog();

let workDir: string;
let configDir: string;
let originalCwd: string;

const envFileContent = () => fs.readFileSync(path.join(workDir, MIGRATE_ENV_FILE), "utf-8");

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-settings-cmd-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-settings-cfg-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  fs.rmSync(path.join(workDir, MIGRATE_ENV_FILE), { force: true });
  fs.rmSync(path.join(workDir, ".gitignore"), { force: true });
});

afterEach(() => {
  process.exitCode = 0;
});

describe("displayValue", () => {
  const signerKey = findSetting("firebase-signer-key")!;

  // No part of the value, at any length — the same `[REDACTED]` that
  // `clerk users create --dry-run` prints for a password.
  test.each([["short"], ["0123456789"], ["aVeryLongSignerKeyValue123456"]])(
    "withholds the credential %p entirely",
    (value) => {
      expect(displayValue(signerKey, value)).toBe("[REDACTED]");
    },
  );

  test("shows a setting that is not a credential", () => {
    expect(displayValue(findSetting("transformer")!, "firebase")).toBe("firebase");
  });
});

describe("set", () => {
  test("writes a credential to the gitignored env file, not the CLI config", async () => {
    await set("firebase-signer-key", "aVeryLongSignerKeyValue123456");

    expect(envFileContent()).toContain("CLERK_FIREBASE_SIGNER_KEY=aVeryLongSignerKeyValue123456");
    expect(await loadSettings()).toEqual({});
    expect(fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8")).toContain(MIGRATE_ENV_FILE);
  });

  test("writes project state to the CLI config, not the env file", async () => {
    await set("transformer", "firebase");

    expect(await loadSettings()).toEqual({ transformer: "firebase" });
    expect(fs.existsSync(path.join(workDir, MIGRATE_ENV_FILE))).toBe(false);
  });

  test("keeps the settings it is not changing", async () => {
    await saveSettings({ transformer: "clerk", file: "users.json" });
    await set("file", "other.json");

    expect(await loadSettings()).toEqual({ transformer: "clerk", file: "other.json" });
  });

  test("stores a boolean setting as a boolean", async () => {
    await set("skip-unsupported-providers", "true");
    expect(await loadSettings()).toEqual({ skipUnsupportedProviders: true });
  });

  test.each([
    ["firebase-rounds", "zero", /positive whole number/],
    ["skip-unsupported-providers", "yes", /true or false/],
  ])("rejects an invalid value for %s", async (name, value, message) => {
    await expect(set(name, value)).rejects.toThrow(message);
  });

  test("names the valid settings when given an unknown one", async () => {
    await expect(set("nope", "x")).rejects.toThrow(/firebase-signer-key/);
  });

  // A run would fail on it later; failing at write time keeps the bad value out
  // of the file entirely.
  test("writes nothing when the value is rejected", async () => {
    await expect(set("firebase-rounds", "-1")).rejects.toThrow();
    expect(fs.existsSync(path.join(workDir, MIGRATE_ENV_FILE))).toBe(false);
  });
});

describe("list", () => {
  test("names the source each value resolved from", async () => {
    await set("transformer", "firebase");
    await set("firebase-salt-separator", "Bw==");
    captured.clear();

    await list();

    expect(captured.err).toContain("clerk config");
    expect(captured.err).toContain(MIGRATE_ENV_FILE);
  });

  test("redacts a credential but not the rest", async () => {
    await set("firebase-signer-key", "aVeryLongSignerKeyValue123456");
    await set("transformer", "firebase");
    captured.clear();

    await list();

    expect(captured.err).toContain("[REDACTED]");
    expect(captured.err).not.toContain("aVeryLongSignerKeyValue123456");
    expect(captured.err).toContain("firebase");
  });

  // --json is what gets piped into a ticket or a CI log.
  test("redacts in JSON output too", async () => {
    await set("firebase-signer-key", "aVeryLongSignerKeyValue123456");
    captured.clear();

    await list({ json: true });

    expect(captured.out).not.toContain("aVeryLongSignerKeyValue123456");
    expect(JSON.parse(captured.out)).toContainEqual(
      expect.objectContaining({ name: "firebase-signer-key", value: "[REDACTED]", secret: true }),
    );
  });

  // The names are kebab-case because they mirror the `migrate import` flags; the
  // description column is what makes the list readable.
  test("explains each setting in prose", async () => {
    await list();

    expect(captured.err).toContain("Source platform the export came from");
    expect(captured.err).toContain("Export file to import users from");
  });

  test("carries the description into JSON too", async () => {
    await list({ json: true });

    expect(JSON.parse(captured.out)).toContainEqual(
      expect.objectContaining({ name: "file", description: "Export file to import users from" }),
    );
  });

  // Colouring before padding counts the ANSI bytes towards the column width,
  // which pulls later columns left on exactly the rows that have a value.
  test("starts the description at one column, set or not", async () => {
    await set("transformer", "supabase");
    captured.clear();

    await list();

    // eslint-disable-next-line no-control-regex
    const plain = captured.err.replaceAll(/\u001B\[\d+m/g, "");
    const columnOf = (description: string) =>
      plain
        .split("\n")
        .find((row) => row.includes(description))
        ?.indexOf(description);

    expect(columnOf("Source platform the export came from")).toBe(
      columnOf("Export file to import users from") as number,
    );
  });

  test("marks everything as unset in a fresh project", async () => {
    await list({ json: true });
    expect(JSON.parse(captured.out).every((entry: { set: boolean }) => !entry.set)).toBe(true);
  });

  // A listing is where someone lands before they know what to type, so it
  // closes by naming the two commands that change what it just showed —
  // the same next-steps block `mcp list` and `whoami` end on.
  test("closes with next steps", async () => {
    setMode("human");
    await list();
    setMode("agent");

    expect(captured.err).toContain("clerk migrate settings set <name> <value>");
    expect(captured.err).toContain("clerk migrate settings clear");
  });

  test("counts how many are set", async () => {
    await set("transformer", "firebase");
    captured.clear();

    await list();

    expect(captured.err).toContain("1 of 8 settings set");
  });

  // Firebase's own names for these, and what every guide tells you to paste
  // into `.env`. Reporting "not set" for a value the import would read is the
  // listing being wrong about the project rather than strict about it.
  test("reads a credential written under the name Firebase uses", async () => {
    fs.writeFileSync(path.join(workDir, ".env.local"), "ROUNDS=8\n");
    captured.clear();

    await list();

    fs.rmSync(path.join(workDir, ".env.local"));
    // Named alongside the file: `ROUNDS` may mean something else in this app.
    expect(captured.err).toContain(".env.local (ROUNDS)");
  });
});

describe("clear", () => {
  test("empties both stores", async () => {
    await set("transformer", "firebase");
    await set("firebase-signer-key", "aVeryLongSignerKeyValue123456");

    await clear({ yes: true });

    expect(await loadSettings()).toEqual({});
    expect(fs.existsSync(path.join(workDir, MIGRATE_ENV_FILE))).toBe(false);
  });

  test("says so rather than claiming to have cleared nothing", async () => {
    await clear({ yes: true });
    expect(captured.err).toContain("No migration settings to clear");
  });

  test("leaves settings the migration does not own", async () => {
    fs.writeFileSync(path.join(workDir, MIGRATE_ENV_FILE), "OTHER=keep\n");
    await set("firebase-rounds", "8");

    await clear({ yes: true });

    expect(envFileContent()).toBe("OTHER=keep\n");
  });
});
