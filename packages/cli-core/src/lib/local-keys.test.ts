import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFolderKeys } from "./local-keys.ts";

// Every name the reader consults with no framework detected. Cleared before
// each test, not only after, so a value exported in the developer's or CI's
// shell can't decide the first test.
const KEY_ENV_NAMES = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
];

describe("readFolderKeys", () => {
  let dir: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clerk-local-keys-"));
    for (const name of KEY_ENV_NAMES) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    await rm(dir, { recursive: true, force: true });
  });

  async function write(relativePath: string, content: string): Promise<void> {
    await Bun.write(join(dir, relativePath), content);
  }

  async function writeSdkKeylessFile(keys: { publishableKey?: string; secretKey?: string }) {
    await write(
      ".clerk/.tmp/keyless.json",
      JSON.stringify({ ...keys, claimUrl: "https://dashboard.clerk.com/apps/claim?token=t" }),
    );
  }

  test(".env.local wins over .env when they hold different keys", async () => {
    await write(
      ".env",
      "CLERK_PUBLISHABLE_KEY=pk_test_from_env\nCLERK_SECRET_KEY=sk_test_from_env\n",
    );
    await write(
      ".env.local",
      "CLERK_PUBLISHABLE_KEY=pk_test_from_local\nCLERK_SECRET_KEY=sk_test_from_local\n",
    );

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: { value: "pk_test_from_local", source: ".env.local" },
      secretKey: { value: "sk_test_from_local", source: ".env.local" },
    });
  });

  test("an env var wins over both files", async () => {
    await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_from_env\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_from_local\n");
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_from_shell";

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_from_shell",
      source: "CLERK_PUBLISHABLE_KEY env var",
    });
  });

  test("the framework's own variable name wins over the generic one", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await write(".env", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_framework\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_generic\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_framework",
      source: ".env",
    });
  });

  test("a plain secret key is never paired with the SDK keyless file's publishable key", async () => {
    await write(".env", "CLERK_SECRET_KEY=sk_test_plain\n");
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: { value: "sk_test_plain", source: ".env" },
    });
  });

  test("with no plain key, both keys come from the SDK keyless file", async () => {
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: { value: "pk_test_sdk", source: ".clerk/.tmp/keyless.json" },
      secretKey: { value: "sk_test_sdk", source: ".clerk/.tmp/keyless.json" },
    });
  });

  test("an SDK keyless file without a publishable key supplies only its secret key", async () => {
    await writeSdkKeylessFile({ secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: { value: "sk_test_sdk", source: ".clerk/.tmp/keyless.json" },
    });
  });

  test("a folder with no Clerk keys returns neither", async () => {
    await write(".env", "DATABASE_URL=postgres://localhost/db\n");

    expect(await readFolderKeys(dir)).toEqual({ publishableKey: undefined, secretKey: undefined });
  });

  test("a malformed key is returned as found, without throwing", async () => {
    await write(".env", "CLERK_PUBLISHABLE_KEY=not-a-clerk-key\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "not-a-clerk-key",
      source: ".env",
    });
  });
});
