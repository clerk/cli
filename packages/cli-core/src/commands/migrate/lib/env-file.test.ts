import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearMigrateEnvValues,
  findMigrateEnvValue,
  MIGRATE_ENV_FILE,
  writeMigrateEnvValues,
} from "./env-file.ts";

let workDir: string;

const envFile = () => path.join(workDir, MIGRATE_ENV_FILE);
const read = (file: string) => fs.readFileSync(path.join(workDir, file), "utf-8");

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-envfile-")));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("writeMigrateEnvValues", () => {
  test("creates the file and gitignores it", async () => {
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);

    expect(read(MIGRATE_ENV_FILE)).toBe("CLERK_FIREBASE_ROUNDS=8\n");
    expect(read(".gitignore")).toContain(MIGRATE_ENV_FILE);
  });

  test("appends to an existing .gitignore without duplicating the entry", async () => {
    fs.writeFileSync(path.join(workDir, ".gitignore"), "node_modules\n");

    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);
    await writeMigrateEnvValues({ CLERK_FIREBASE_MEM_COST: "14" }, workDir);

    expect(read(".gitignore")).toBe(`node_modules\n${MIGRATE_ENV_FILE}\n`);
  });

  // The header `mergeEnvVars` adds is right for an app's shared .env and wrong
  // here — one `settings set` per key would stack one header per call.
  test("adds no section header, however many times it is called", async () => {
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);
    await writeMigrateEnvValues({ CLERK_FIREBASE_MEM_COST: "14" }, workDir);
    await writeMigrateEnvValues({ CLERK_FIREBASE_SIGNER_KEY: "k" }, workDir);

    expect(read(MIGRATE_ENV_FILE)).not.toContain("#");
  });

  test("updates a key in place rather than appending a second copy", async () => {
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "10" }, workDir);

    expect(read(MIGRATE_ENV_FILE)).toBe("CLERK_FIREBASE_ROUNDS=10\n");
  });

  // The file is meant to be hand-editable, so a write must not flatten it.
  test("preserves hand-written comments and unrelated keys", async () => {
    fs.writeFileSync(envFile(), "# my note\nOTHER=keep\n");

    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);

    expect(read(MIGRATE_ENV_FILE)).toBe("# my note\nOTHER=keep\nCLERK_FIREBASE_ROUNDS=8\n");
  });
});

describe("findMigrateEnvValue", () => {
  test("reads a value out of the file", async () => {
    await writeMigrateEnvValues({ CLERK_FIREBASE_SIGNER_KEY: "from-file" }, workDir);

    const located = await findMigrateEnvValue(["CLERK_FIREBASE_SIGNER_KEY"], workDir, {});
    expect(located).toEqual({
      value: "from-file",
      name: "CLERK_FIREBASE_SIGNER_KEY",
      source: MIGRATE_ENV_FILE,
    });
  });

  test("beats the app's own .env.local", async () => {
    fs.writeFileSync(path.join(workDir, ".env.local"), "CLERK_FIREBASE_ROUNDS=1\n");
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);

    const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {});
    expect(located?.value).toBe("8");
  });

  // An exported variable is the one thing an operator can change per-invocation.
  test("loses to an exported environment variable", async () => {
    await writeMigrateEnvValues({ CLERK_FIREBASE_ROUNDS: "8" }, workDir);

    const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {
      CLERK_FIREBASE_ROUNDS: "99",
    });
    expect(located).toEqual({
      value: "99",
      name: "CLERK_FIREBASE_ROUNDS",
      source: "CLERK_FIREBASE_ROUNDS env var",
    });
  });

  test("returns nothing when the setting is absent everywhere", async () => {
    expect(await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {})).toBeUndefined();
  });

  // Bun loads `.env.local` into process.env before the CLI runs, so a value a
  // developer put in a file arrives looking like an exported variable. Naming
  // the variable answers nothing — the question is which file to edit.
  describe("attributing an environment value to the file it came from", () => {
    test("names the file when it holds the same value", async () => {
      fs.writeFileSync(path.join(workDir, ".env.local"), "CLERK_FIREBASE_ROUNDS=8\n");

      const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {
        CLERK_FIREBASE_ROUNDS: "8",
      });
      expect(located?.source).toBe(".env.local");
    });

    // The one case the source column exists for: the file lost, so naming it
    // would point at the value that is not being used.
    test("keeps the variable when the file holds a different value", async () => {
      fs.writeFileSync(path.join(workDir, ".env.local"), "CLERK_FIREBASE_ROUNDS=8\n");

      const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {
        CLERK_FIREBASE_ROUNDS: "99",
      });
      expect(located?.source).toBe("CLERK_FIREBASE_ROUNDS env var");
    });

    test("prefers the file the runtime would have loaded last", async () => {
      fs.writeFileSync(path.join(workDir, ".env"), "CLERK_FIREBASE_ROUNDS=8\n");
      fs.writeFileSync(path.join(workDir, ".env.local"), "CLERK_FIREBASE_ROUNDS=8\n");

      const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {
        CLERK_FIREBASE_ROUNDS: "8",
      });
      expect(located?.source).toBe(".env.local");
    });

    test("keeps the variable when no file holds it at all", async () => {
      const located = await findMigrateEnvValue(["CLERK_FIREBASE_ROUNDS"], workDir, {
        CLERK_FIREBASE_ROUNDS: "8",
      });
      expect(located?.source).toBe("CLERK_FIREBASE_ROUNDS env var");
    });
  });
});

describe("clearMigrateEnvValues", () => {
  test("removes only the named settings", async () => {
    fs.writeFileSync(envFile(), "OTHER=keep\nCLERK_FIREBASE_ROUNDS=8\n");

    expect(await clearMigrateEnvValues(["CLERK_FIREBASE_ROUNDS"], workDir)).toEqual([
      "CLERK_FIREBASE_ROUNDS",
    ]);
    expect(read(MIGRATE_ENV_FILE)).toBe("OTHER=keep\n");
  });

  // Left behind, it reads as "there is config here" when there is not.
  test("deletes the file when nothing but comments would remain", async () => {
    fs.writeFileSync(envFile(), "# a note\nCLERK_FIREBASE_ROUNDS=8\n");

    await clearMigrateEnvValues(["CLERK_FIREBASE_ROUNDS"], workDir);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  test("reports nothing dropped when there is no file", async () => {
    expect(await clearMigrateEnvValues(["CLERK_FIREBASE_ROUNDS"], workDir)).toEqual([]);
  });
});
