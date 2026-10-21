/**
 * How an unlinked folder is classified, from real files on disk.
 *
 * Every row runs with each credential: a stored session, only
 * `CLERK_PLATFORM_API_KEY`, and none. The token override stands in for the
 * keychain, so no test reads the developer's real session.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../test/lib/clerk-key-env.ts";
import { _setTokenOverride } from "./credential-store.ts";
import * as localKeys from "./local-keys.ts";
import { classifyUnlinkedFolder, readUnlinkedFolder, type Credential } from "./unlinked-folder.ts";

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

const savedApiKey = process.env.CLERK_PLATFORM_API_KEY;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clerk-unlinked-folder-"));
  delete process.env.CLERK_PLATFORM_API_KEY;
  _setTokenOverride(null);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(() => {
  _setTokenOverride(undefined);
  if (savedApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = savedApiKey;
});

async function write(relativePath: string, content: string): Promise<void> {
  await Bun.write(join(dir, relativePath), content);
}

const INIT_TOKEN = JSON.stringify({ claimToken: "init_token", createdAt: "2026-10-21T00:00:00Z" });
const ENV_KEYS = "CLERK_PUBLISHABLE_KEY=pk_test_from_env\nCLERK_SECRET_KEY=sk_test_from_env\n";
/** `claimUrl: null` writes a file without one. */
const sdkFile = (
  keys: { publishableKey?: string; secretKey?: string },
  claimUrl: string | null = "https://dashboard.clerk.com/apps/claim?token=t",
) => JSON.stringify({ ...keys, ...(claimUrl !== null && { claimUrl }) });

const CREDENTIALS: {
  label: string;
  token: string | null;
  apiKey: string | undefined;
  credential: Credential;
}[] = [
  { label: "a stored session", token: "oauth_session", apiKey: undefined, credential: "session" },
  { label: "only CLERK_PLATFORM_API_KEY", token: null, apiKey: "ak_fake", credential: "api_key" },
  // Platform API calls use the key over the session, so the key is what counts.
  { label: "both", token: "oauth_session", apiKey: "ak_fake", credential: "api_key" },
  { label: "no credentials", token: null, apiKey: undefined, credential: "none" },
];

const ROWS: {
  row: string;
  files: Record<string, string>;
  env?: Record<string, string>;
  expected: object;
}[] = [
  {
    row: "init token only",
    files: { ".clerk/keyless.json": INIT_TOKEN },
    expected: { kind: "init_app" },
  },
  {
    row: "init token with .env keys",
    files: { ".clerk/keyless.json": INIT_TOKEN, ".env": ENV_KEYS },
    expected: { kind: "init_app" },
  },
  {
    row: "init token with only the SDK keyless file",
    files: {
      ".clerk/keyless.json": INIT_TOKEN,
      ".clerk/.tmp/keyless.json": sdkFile({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
      }),
    },
    expected: { kind: "init_app" },
  },
  {
    row: "SDK keyless file only",
    files: {
      ".clerk/.tmp/keyless.json": sdkFile({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
      }),
    },
    expected: { kind: "sdk_app" },
  },
  {
    row: "SDK keyless file with a secret key but no publishable key",
    files: { ".clerk/.tmp/keyless.json": sdkFile({ secretKey: "sk_test_sdk" }) },
    expected: {
      kind: "sdk_app",
      unusable: { reason: "it has no publishable key", findableByKey: false },
    },
  },
  {
    row: "an SDK keyless file that can't be read",
    files: { ".clerk/.tmp/keyless.json": "{ half-written" },
    expected: { kind: "sdk_app", unusable: { reason: "it can't be read", findableByKey: false } },
  },
  // `clerk link` still finds such an app by its key, but can't send anyone to claim it.
  {
    row: "an SDK keyless file with a publishable key but no claim URL",
    files: {
      ".clerk/.tmp/keyless.json": sdkFile(
        { publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" },
        null,
      ),
    },
    expected: { kind: "sdk_app", unusable: { reason: "it has no claim URL", findableByKey: true } },
  },
  {
    row: "an SDK keyless file with a publishable key and a claim URL that isn't https",
    files: {
      ".clerk/.tmp/keyless.json": sdkFile(
        { publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" },
        "http://dashboard.clerk.com/apps/claim?token=t",
      ),
    },
    expected: {
      kind: "sdk_app",
      unusable: { reason: "its claim URL isn't an https link", findableByKey: true },
    },
  },
  {
    row: "SDK keyless file with .env keys",
    files: {
      ".clerk/.tmp/keyless.json": sdkFile({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
      }),
      ".env": ENV_KEYS,
    },
    expected: {
      kind: "unknown_owner",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
      secretKey: { name: "CLERK_SECRET_KEY", source: ".env" },
    },
  },
  {
    row: "a plain secret key next to an SDK keyless file",
    files: {
      ".clerk/.tmp/keyless.json": sdkFile({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
      }),
      ".env": "CLERK_SECRET_KEY=sk_test_from_env\n",
    },
    expected: { kind: "unknown_owner", secretKey: { name: "CLERK_SECRET_KEY", source: ".env" } },
  },
  {
    row: ".env only",
    files: { ".env": ENV_KEYS },
    expected: {
      kind: "unknown_owner",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
      secretKey: { name: "CLERK_SECRET_KEY", source: ".env" },
    },
  },
  {
    row: ".env.local only",
    files: { ".env.local": ENV_KEYS },
    expected: {
      kind: "unknown_owner",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env.local" },
      secretKey: { name: "CLERK_SECRET_KEY", source: ".env.local" },
    },
  },
  {
    row: "a publishable key only",
    files: { ".env": "CLERK_PUBLISHABLE_KEY=pk_test_from_env\n" },
    expected: {
      kind: "unknown_owner",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
    },
  },
  {
    row: "a secret key only",
    files: { ".env": "CLERK_SECRET_KEY=sk_test_from_env\n" },
    expected: { kind: "unknown_owner", secretKey: { name: "CLERK_SECRET_KEY", source: ".env" } },
  },
  {
    row: "a secret key in an env var only",
    files: {},
    env: { CLERK_SECRET_KEY: "sk_test_from_shell" },
    expected: {
      kind: "unknown_owner",
      secretKey: { name: "CLERK_SECRET_KEY", source: "CLERK_SECRET_KEY env var" },
    },
  },
  {
    row: "a malformed key",
    files: { ".env": "CLERK_PUBLISHABLE_KEY=not-a-clerk-key\n" },
    expected: {
      kind: "unknown_owner",
      publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
    },
  },
  {
    row: "files that disagree, with no framework to say which loads",
    files: {
      ".env": "CLERK_PUBLISHABLE_KEY=pk_test_one\n",
      ".env.local": "CLERK_PUBLISHABLE_KEY=pk_test_two\n",
    },
    expected: {
      kind: "unknown_owner",
      couldntTell: expect.stringContaining("hold different Clerk publishable keys"),
    },
  },
  {
    row: "a Clerk line the CLI can't parse",
    files: { ".env": "  CLERK_PUBLISHABLE_KEY = pk_test_spaced\n" },
    expected: {
      kind: "unknown_owner",
      couldntTell: expect.stringContaining("couldn't read the `CLERK_PUBLISHABLE_KEY` line"),
    },
  },
  { row: "nothing", files: {}, expected: { kind: "no_app" } },
];

describe.each(CREDENTIALS)("with $label", ({ token, apiKey, credential }) => {
  beforeEach(() => {
    _setTokenOverride(token);
    if (apiKey) process.env.CLERK_PLATFORM_API_KEY = apiKey;
  });

  test.each(ROWS)("$row", async ({ files, env, expected }) => {
    for (const [path, content] of Object.entries(files)) await write(path, content);
    Object.assign(process.env, env);

    expect(await readUnlinkedFolder(dir)).toEqual({ ...expected, credential } as never);
  });

  test("env files that can't be read: couldn't tell, without throwing", async () => {
    const read = spyOn(localKeys, "readFolderKeys").mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, open '.env.local'"), { code: "EACCES" }),
    );
    try {
      expect(await readUnlinkedFolder(dir)).toEqual({
        kind: "unknown_owner",
        credential,
        couldntTell: expect.stringContaining("couldn't read this folder's env files"),
      });
    } finally {
      read.mockRestore();
    }
  });
});

test("a run from a subdirectory of a folder with keys reads only the subdirectory: no app", async () => {
  await write(".env", ENV_KEYS);
  await mkdir(join(dir, "packages", "web"), { recursive: true });

  expect(await readUnlinkedFolder(join(dir, "packages", "web"))).toEqual({
    kind: "no_app",
    credential: "none",
  });
});

test("a malformed token file isn't an init token, and is still on disk after reading", async () => {
  await write(".clerk/keyless.json", JSON.stringify({ claimToken: 42 }));

  expect(await readUnlinkedFolder(dir)).toEqual({ kind: "no_app", credential: "none" });
  expect(await Bun.file(join(dir, ".clerk/keyless.json")).exists()).toBe(true);
});

test("a failed read of the stored session counts as no credential", async () => {
  const credentials = await import("./credential-store.ts");
  const check = spyOn(credentials, "hasStoredCredentials").mockRejectedValue(
    new Error("keychain unavailable"),
  );
  try {
    expect(await readUnlinkedFolder(dir)).toEqual({ kind: "no_app", credential: "none" });
  } finally {
    check.mockRestore();
  }
});

// `doctor` builds the facts from its own memoized reads and calls this directly.
describe("classifyUnlinkedFolder", () => {
  test("an init token wins over everything else the folder holds", () => {
    expect(
      classifyUnlinkedFolder({
        initToken: true,
        sdkClaimLinkProblem: undefined,
        credential: "session",
        keys: { readError: "the CLI couldn't read this folder's env files (EACCES)" },
      }),
    ).toEqual({ kind: "init_app", credential: "session" });
  });

  test("keys that couldn't be read: couldn't tell, with the reason", () => {
    expect(
      classifyUnlinkedFolder({
        initToken: false,
        sdkClaimLinkProblem: undefined,
        credential: "none",
        keys: { readError: "the CLI couldn't read this folder's env files (EACCES)" },
      }),
    ).toEqual({
      kind: "unknown_owner",
      credential: "none",
      couldntTell: "the CLI couldn't read this folder's env files (EACCES)",
    });
  });

  test("secret keys that disagree, with no publishable key: secret key only, no location", () => {
    expect(
      classifyUnlinkedFolder({
        initToken: false,
        sdkClaimLinkProblem: undefined,
        credential: "session",
        keys: {
          undecided: {
            secret: [
              { value: "sk_test_one", name: "CLERK_SECRET_KEY", source: ".env" },
              { value: "sk_test_two", name: "CLERK_SECRET_KEY", source: ".env.local" },
            ],
          },
        },
      }),
    ).toEqual({ kind: "unknown_owner", credential: "session" });
  });

  test("never carries a key's value", () => {
    const folder = classifyUnlinkedFolder({
      initToken: false,
      sdkClaimLinkProblem: undefined,
      credential: "session",
      keys: {
        publishableKey: { value: "pk_test_value", name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
        secretKey: { value: "sk_test_value", name: "CLERK_SECRET_KEY", source: ".env" },
      },
    });

    expect(JSON.stringify(folder)).not.toContain("_value");
  });

  // The caller reads the claim link (`readSdkClaimLink`) and passes only its reason.
  test("an SDK-only folder whose claim link is unusable: findable by key, not claimable", () => {
    expect(
      classifyUnlinkedFolder({
        initToken: false,
        credential: "api_key",
        sdkClaimLinkProblem: "it has no claim URL",
        keys: {
          publishableKey: {
            value: "pk_test_sdk",
            name: "publishableKey",
            source: ".clerk/.tmp/keyless.json",
          },
          sdkFile: { state: "parsed", publishableKey: "pk_test_sdk" },
        },
      }),
    ).toEqual({
      kind: "sdk_app",
      credential: "api_key",
      unusable: { reason: "it has no claim URL", findableByKey: true },
    });
  });
});

test("an unusable claim link is reported by its reason, never its URL", async () => {
  await write(
    ".clerk/.tmp/keyless.json",
    sdkFile(
      { publishableKey: "pk_test_sdk" },
      "http://dashboard.clerk.com/apps/claim?token=secret_claim",
    ),
  );

  expect(JSON.stringify(await readUnlinkedFolder(dir))).not.toContain("secret_claim");
});
