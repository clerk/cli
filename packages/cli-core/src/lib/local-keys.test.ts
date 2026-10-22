import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../test/lib/clerk-key-env.ts";
import { readAllFolderKeys, readFolderKeys, readSdkKeylessApp } from "./local-keys.ts";

// The shell exports a synthetic key under every Clerk name for the whole file,
// and every test starts with them cleared. A block that skipped the clearing
// would fail on a synthetic value, never print a real one.
useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clerk-local-keys-"));
});

afterEach(async () => {
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

describe("readFolderKeys", () => {
  test(".env.local wins over .env when they hold different keys (Next.js)", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await write(
      ".env",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_from_env\nCLERK_SECRET_KEY=sk_test_from_env\n",
    );
    await write(
      ".env.local",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_from_local\nCLERK_SECRET_KEY=sk_test_from_local\n",
    );

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: {
        value: "pk_test_from_local",
        name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        source: ".env.local",
      },
      secretKey: { value: "sk_test_from_local", name: "CLERK_SECRET_KEY", source: ".env.local" },
    });
  });

  test("an env var wins over both files", async () => {
    await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_from_env\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_from_local\n");
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_from_shell";

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_from_shell",
      name: "CLERK_PUBLISHABLE_KEY",
      source: "CLERK_PUBLISHABLE_KEY env var",
    });
  });

  test("the framework's own variable name wins over the generic one", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await write(".env", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_framework\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_generic\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_framework",
      name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      source: ".env",
    });
  });

  test("a plain secret key is never paired with the SDK keyless file's publishable key", async () => {
    await write(".env", "CLERK_SECRET_KEY=sk_test_plain\n");
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: { value: "sk_test_plain", name: "CLERK_SECRET_KEY", source: ".env" },
    });
  });

  test("with no plain key, both keys come from the SDK keyless file", async () => {
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: {
        value: "pk_test_sdk",
        name: "publishableKey",
        source: ".clerk/.tmp/keyless.json",
      },
      secretKey: { value: "sk_test_sdk", name: "secretKey", source: ".clerk/.tmp/keyless.json" },
      sdkFile: { state: "parsed", publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" },
    });
  });

  test("an SDK keyless file without a publishable key supplies only its secret key", async () => {
    await writeSdkKeylessFile({ secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: { value: "sk_test_sdk", name: "secretKey", source: ".clerk/.tmp/keyless.json" },
      sdkFile: { state: "parsed", publishableKey: undefined, secretKey: "sk_test_sdk" },
    });
  });

  test("a folder with no Clerk keys returns neither", async () => {
    await write(".env", "DATABASE_URL=postgres://localhost/db\n");

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: undefined,
      sdkFile: { state: "absent" },
    });
  });

  test("a malformed key is returned as found, without throwing", async () => {
    await write(".env", "CLERK_PUBLISHABLE_KEY=not-a-clerk-key\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "not-a-clerk-key",
      name: "CLERK_PUBLISHABLE_KEY",
      source: ".env",
    });
  });

  // Otherwise milestone 4 would treat a folder whose plain key it can't read
  // as one holding only the SDK's keys.
  test("reports a Clerk line it can't parse, and then doesn't fall back to the SDK keyless file", async () => {
    await write(".env", "  CLERK_SECRET_KEY=sk_test_indented\n");
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: undefined,
      unreadableLines: [{ kind: "secret", name: "CLERK_SECRET_KEY", source: ".env" }],
    });
  });
});

// The key the app loads follows each framework's documented env file order,
// and the CLI answers "couldn't tell" rather than guess for any other
// framework whose files disagree.
describe("the key the app loads, by framework", () => {
  async function useFramework(dep: string) {
    await write("package.json", JSON.stringify({ dependencies: { [dep]: "1.0.0" } }));
  }

  const located = (value: string, source: string, name = "CLERK_PUBLISHABLE_KEY") => ({
    value,
    name,
    source,
  });

  test.each([
    { files: [".env.local", ".env.development.local"], loads: ".env.development.local" },
    { files: [".env", ".env.development"], loads: ".env.development" },
    { files: [".env.development", ".env.local"], loads: ".env.local" },
  ])("Next.js: $loads wins over the other of $files", async ({ files, loads }) => {
    await useFramework("next");
    for (const file of files) {
      await write(file, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_${file}\n`);
    }

    expect((await readFolderKeys(dir)).publishableKey).toEqual(
      located(`pk_test_${loads}`, loads, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    );
  });

  // Vite loads `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`, later
  // files winning: a mode file beats `.env.local`, unlike Next.js.
  // Each with the name its SDK reads: Astro's has no `VITE_` prefix.
  test.each([
    { dep: "vite", name: "VITE_CLERK_PUBLISHABLE_KEY" },
    { dep: "astro", name: "PUBLIC_CLERK_PUBLISHABLE_KEY" },
    { dep: "vue", name: "VITE_CLERK_PUBLISHABLE_KEY" },
    { dep: "react-router", name: "VITE_CLERK_PUBLISHABLE_KEY" },
    { dep: "@tanstack/react-start", name: "VITE_CLERK_PUBLISHABLE_KEY" },
    { dep: "react", name: "VITE_CLERK_PUBLISHABLE_KEY" },
  ])(
    "the Vite family ($dep): .env.development wins over .env.local, and .env.development.local over both",
    async ({ dep, name }) => {
      await useFramework(dep);
      await write(".env.local", `${name}=pk_test_local\n`);
      await write(".env.development", `${name}=pk_test_development\n`);

      expect((await readFolderKeys(dir)).publishableKey).toEqual(
        located("pk_test_development", ".env.development", name),
      );

      await write(".env.development.local", `${name}=pk_test_development_local\n`);

      expect((await readFolderKeys(dir)).publishableKey).toEqual(
        located("pk_test_development_local", ".env.development.local", name),
      );
    },
  );

  test("Nuxt loads only .env, so a key in .env.local isn't the one it runs on", async () => {
    await useFramework("nuxt");
    await write(".env", "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_env\n");
    await write(".env.local", "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_local\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual(
      located("pk_test_env", ".env", "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    );
  });

  test("Nuxt with a key only in .env.local loads no key", async () => {
    await useFramework("nuxt");
    await write(".env.local", "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_local\n");

    expect((await readFolderKeys(dir)).publishableKey).toBeUndefined();
  });

  test.each([
    { framework: "Express", dep: "express" },
    { framework: "no detected framework", dep: undefined },
  ])(
    "$framework: files holding different keys leave both keys undecided, never picking one",
    async ({ dep }) => {
      if (dep) await useFramework(dep);
      await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_a\nCLERK_SECRET_KEY=sk_test_a\n");
      await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_b\nCLERK_SECRET_KEY=sk_test_b\n");
      // Undecided keys are plain keys: the SDK's file doesn't stand in for them.
      await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

      expect(await readFolderKeys(dir)).toEqual({
        publishableKey: undefined,
        secretKey: undefined,
        undecided: {
          publishable: [located("pk_test_b", ".env.local"), located("pk_test_a", ".env")],
          secret: [
            { value: "sk_test_b", name: "CLERK_SECRET_KEY", source: ".env.local" },
            { value: "sk_test_a", name: "CLERK_SECRET_KEY", source: ".env" },
          ],
        },
      });
    },
  );

  test("no documented order: files that agree give that key", async () => {
    await useFramework("express");
    await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_same\n");
    await write(".env.development", "CLERK_PUBLISHABLE_KEY=pk_test_same\n");

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: located("pk_test_same", ".env.development"),
      secretKey: undefined,
    });
  });

  // Next.js reads only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, Astro only
  // `PUBLIC_CLERK_PUBLISHABLE_KEY`, Nuxt only its runtime config's
  // `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and Vue no env var at all (the app
  // passes Vite's name itself), per Clerk's SDK source. So the generic name in
  // the shell or a file isn't a key those apps load. Each in a file its
  // framework loads: Nuxt loads only `.env`.
  const OWN_NAME_ONLY = [
    {
      framework: "Next.js",
      dep: "next",
      own: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      file: ".env.local",
    },
    { framework: "Astro", dep: "astro", own: "PUBLIC_CLERK_PUBLISHABLE_KEY", file: ".env.local" },
    { framework: "Nuxt", dep: "nuxt", own: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY", file: ".env" },
    { framework: "Vue", dep: "vue", own: "VITE_CLERK_PUBLISHABLE_KEY", file: ".env.local" },
  ];

  test.each(OWN_NAME_ONLY)(
    "$framework: its own name in a file wins over an exported generic key",
    async ({ dep, own, file }) => {
      await useFramework(dep);
      process.env.CLERK_PUBLISHABLE_KEY = "pk_test_exported_generic";
      await write(file, `${own}=pk_test_own_name\n`);

      expect((await readFolderKeys(dir)).publishableKey).toEqual({
        value: "pk_test_own_name",
        name: own,
        source: file,
      });
    },
  );

  test.each(OWN_NAME_ONLY)(
    "$framework: a generic key alone isn't a key the app loads",
    async ({ dep, file }) => {
      await useFramework(dep);
      await write(file, "CLERK_PUBLISHABLE_KEY=pk_test_generic_only\n");

      expect((await readFolderKeys(dir)).publishableKey).toBeUndefined();
    },
  );

  // The React SDKs read `VITE_CLERK_PUBLISHABLE_KEY`, then the generic name.
  test("React: its own name in a file wins over an exported generic key", async () => {
    await useFramework("react");
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_exported_generic";
    await write(".env.local", "VITE_CLERK_PUBLISHABLE_KEY=pk_test_own_name\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_own_name",
      name: "VITE_CLERK_PUBLISHABLE_KEY",
      source: ".env.local",
    });
  });

  test("React: a generic key alone is still the fallback", async () => {
    await useFramework("react");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_generic_only\n");

    expect((await readFolderKeys(dir)).publishableKey).toEqual(
      located("pk_test_generic_only", ".env.local"),
    );
  });

  test("no documented order: an exported key still wins over files that disagree", async () => {
    await useFramework("express");
    await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_a\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_b\n");
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_shell";

    expect((await readFolderKeys(dir)).publishableKey).toEqual({
      value: "pk_test_shell",
      name: "CLERK_PUBLISHABLE_KEY",
      source: "CLERK_PUBLISHABLE_KEY env var",
    });
  });
});

// The SDK keyless file's state is data, not an error: the claim check reads an
// unusable file as "couldn't tell", while `clerk link` has its own stop for it.
describe("the SDK keyless file's state", () => {
  test.each([
    { name: "can't be parsed", content: "{ half-written" },
    { name: "isn't a JSON object", content: "null" },
  ])("is reported as unreadable, without throwing, when the file $name", async ({ content }) => {
    await write(".clerk/.tmp/keyless.json", content);

    expect(await readFolderKeys(dir)).toEqual({
      publishableKey: undefined,
      secretKey: undefined,
      sdkFile: { state: "unreadable" },
    });
    // Existing callers keep tolerating it, as before.
    expect(await readSdkKeylessApp(dir)).toBeUndefined();
  });

  test("is reported as parsed with no keys when the file holds none", async () => {
    await write(
      ".clerk/.tmp/keyless.json",
      JSON.stringify({ claimUrl: "https://example.com/claim" }),
    );

    expect((await readFolderKeys(dir)).sdkFile).toEqual({
      state: "parsed",
      publishableKey: undefined,
      secretKey: undefined,
    });
  });

  test("isn't consulted when the folder has a plain key", async () => {
    await write(".env", "CLERK_SECRET_KEY=sk_test_plain\n");
    await write(".clerk/.tmp/keyless.json", "{ half-written");

    expect((await readFolderKeys(dir)).sdkFile).toBeUndefined();
    expect((await readAllFolderKeys(dir)).sdkFile).toBeUndefined();
  });
});

describe("readAllFolderKeys", () => {
  test("returns every key from the shell and all four env files, each with its source", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_shell";
    await write(".env", "CLERK_PUBLISHABLE_KEY=pk_test_env\n");
    await write(".env.development", "CLERK_SECRET_KEY=sk_test_development\n");
    await write(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_local\n");
    await write(".env.development.local", "CLERK_SECRET_KEY=sk_test_dev_local\n");

    const keys = await readAllFolderKeys(dir);

    expect(keys.publishableKeys).toEqual([
      {
        value: "pk_test_shell",
        name: "CLERK_PUBLISHABLE_KEY",
        source: "CLERK_PUBLISHABLE_KEY env var",
      },
      // Files in `ENV_FILE_CANDIDATES` order; order doesn't matter to the check.
      { value: "pk_test_local", name: "CLERK_PUBLISHABLE_KEY", source: ".env.local" },
      { value: "pk_test_env", name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
    ]);
    expect(keys.secretKeys).toEqual([
      { value: "sk_test_dev_local", name: "CLERK_SECRET_KEY", source: ".env.development.local" },
      { value: "sk_test_development", name: "CLERK_SECRET_KEY", source: ".env.development" },
    ]);
  });

  test("returns keys under the framework's own name and the generic one", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await write(
      ".env.local",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_framework\nCLERK_PUBLISHABLE_KEY=pk_test_generic\n",
    );

    expect((await readAllFolderKeys(dir)).publishableKeys).toEqual([
      {
        value: "pk_test_framework",
        name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        source: ".env.local",
      },
      { value: "pk_test_generic", name: "CLERK_PUBLISHABLE_KEY", source: ".env.local" },
    ]);
  });

  // A workspace package whose framework is declared at the workspace root
  // isn't detected, but its app still reads its framework's names.
  test("returns keys under every supported framework's names when none is detected", async () => {
    await write(
      ".env",
      "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_nuxt\nNUXT_CLERK_SECRET_KEY=sk_test_nuxt\nVITE_CLERK_PUBLISHABLE_KEY=pk_test_vite\n",
    );
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_expo_shell";

    const keys = await readAllFolderKeys(dir);

    expect(keys.publishableKeys.map(({ name, source }) => `${name} from ${source}`)).toEqual([
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY from EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY env var",
      "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY from .env",
      "VITE_CLERK_PUBLISHABLE_KEY from .env",
    ]);
    expect(keys.secretKeys.map(({ name }) => name)).toEqual(["NUXT_CLERK_SECRET_KEY"]);
  });

  test("ignores a shell variable no Clerk SDK reads", async () => {
    process.env.STAGING_CLERK_SECRET_KEY = "sk_test_staging";
    try {
      expect(await readAllFolderKeys(dir)).toEqual({
        publishableKeys: [],
        secretKeys: [],
        sdkFile: { state: "absent" },
      });
    } finally {
      delete process.env.STAGING_CLERK_SECRET_KEY;
    }
  });

  test.each([
    { name: "spaces around =", line: "CLERK_SECRET_KEY = sk_test_spaced" },
    { name: "an indented line", line: "  CLERK_SECRET_KEY=sk_test_indented" },
    { name: "a colon separator", line: "CLERK_SECRET_KEY: sk_test_colon" },
  ])("reports a Clerk line written with $name as unreadable", async ({ line }) => {
    await write(".env", `${line}\n`);

    expect(await readAllFolderKeys(dir)).toEqual({
      publishableKeys: [],
      secretKeys: [],
      unreadableLines: [{ kind: "secret", name: "CLERK_SECRET_KEY", source: ".env" }],
    });
  });

  test("names the most specific Clerk variable an unreadable line mentions", async () => {
    await write(".env", "  NUXT_CLERK_SECRET_KEY=sk_test_indented\n");

    expect((await readAllFolderKeys(dir)).unreadableLines).toEqual([
      { kind: "secret", name: "NUXT_CLERK_SECRET_KEY", source: ".env" },
    ]);
  });

  test("ignores a commented-out key line, which env loaders skip too", async () => {
    await write(".env", "# CLERK_SECRET_KEY=sk_test_old\n  # CLERK_PUBLISHABLE_KEY=pk_test_old\n");

    expect((await readAllFolderKeys(dir)).unreadableLines).toBeUndefined();
  });

  test("with no plain key, returns the SDK keyless file's keys and its state", async () => {
    await writeSdkKeylessFile({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" });

    const keys = await readAllFolderKeys(dir);

    expect(keys.publishableKeys).toEqual([
      { value: "pk_test_sdk", name: "publishableKey", source: ".clerk/.tmp/keyless.json" },
    ]);
    expect(keys.secretKeys).toEqual([
      { value: "sk_test_sdk", name: "secretKey", source: ".clerk/.tmp/keyless.json" },
    ]);
    expect(keys.sdkFile).toEqual({
      state: "parsed",
      publishableKey: "pk_test_sdk",
      secretKey: "sk_test_sdk",
    });
  });
});
