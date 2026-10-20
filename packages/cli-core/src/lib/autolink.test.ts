import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialStoreStubs, gitStubs, stubFetch, useCaptureLog } from "../test/lib/stubs.ts";

mock.module("./credential-store.ts", () => credentialStoreStubs);

const mockGetGitRepoIdentifier = mock();
const mockGetGitNormalizedRemote = mock();
mock.module("./git.ts", () => ({
  ...gitStubs,
  getGitRepoIdentifier: (...args: unknown[]) => mockGetGitRepoIdentifier(...args),
  getGitNormalizedRemote: (...args: unknown[]) => mockGetGitNormalizedRemote(...args),
}));

const { findLinkKey, matchKeyToApp, autolink } = await import("./autolink.ts");
const { _setConfigDir, readConfig } = await import("./config.ts");

const mockApps = [
  {
    application_id: "app_123",
    name: "My App",
    instances: [
      {
        instance_id: "ins_dev",
        environment_type: "development",
        publishable_key: "pk_test_abc",
      },
      {
        instance_id: "ins_prod",
        environment_type: "production",
        publishable_key: "pk_live_abc",
      },
    ],
  },
  {
    application_id: "app_456",
    name: "Other App",
    instances: [
      {
        instance_id: "ins_dev_2",
        environment_type: "development",
        publishable_key: "pk_test_def",
      },
    ],
  },
];

async function writePackageJson(dir: string, dep: string) {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { [dep]: "latest" } }));
}

// `clerk link` matches on one key: the publishable key the folder's app loads.
// It never falls back to another file's key when that one matches nothing.
describe("findLinkKey", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-autolink-test-"));
    process.env = { ...originalEnv };
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete process.env.PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  const found = (value: string, name: string, source: string) => ({
    status: "found" as const,
    key: { value, name, source },
  });

  test("finds none when no keys found", async () => {
    expect(await findLinkKey(tempDir)).toEqual({ status: "none" });
  });

  test("detects CLERK_PUBLISHABLE_KEY from env var", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_test_abc", "CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY env var"),
    );
  });

  test("detects NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY from env var", async () => {
    await writePackageJson(tempDir, "next");
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_next";
    expect(await findLinkKey(tempDir)).toEqual(
      found(
        "pk_test_next",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY env var",
      ),
    );
  });

  test("detects keys from .env.local file", async () => {
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_file\n");
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_test_file", "CLERK_PUBLISHABLE_KEY", ".env.local"),
    );
  });

  test("detects keys from .env file", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_dotenv\n");
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_test_dotenv", "CLERK_PUBLISHABLE_KEY", ".env"),
    );
  });

  // Was a list with the file's key as a fallback; the app loads the exported key.
  test("an exported key is the only candidate, even when a file holds another", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_from_env";
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_from_file\n");
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_from_env", "CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY env var"),
    );
  });

  // Was a list with `.env` as a fallback; Next.js loads `.env.local`'s key.
  test("Next.js: .env.local's key is the only candidate when .env holds another", async () => {
    await writePackageJson(tempDir, "next");
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_dotenv\n");
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_local\n");
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_local", "CLERK_PUBLISHABLE_KEY", ".env.local"),
    );
  });

  test("couldn't tell when no framework order applies and the files disagree", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_dotenv\n");
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_local\n");
    expect(await findLinkKey(tempDir)).toEqual({
      status: "couldnt_tell",
      reason:
        "`.env.local` and `.env` hold different Clerk publishable keys, and the CLI doesn't know which one this app loads",
    });
  });

  test("couldn't tell when a Clerk key line can't be read", async () => {
    await writePackageJson(tempDir, "next");
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_dotenv\n");
    await Bun.write(join(tempDir, ".env.local"), "  CLERK_PUBLISHABLE_KEY=pk_local\n");
    expect(await findLinkKey(tempDir)).toEqual({
      status: "couldnt_tell",
      reason:
        "the CLI couldn't read the `CLERK_PUBLISHABLE_KEY` line in `.env.local`, so it can't tell which key this app loads",
    });
  });

  test("detects framework-specific publishable keys from .env files", async () => {
    await writePackageJson(tempDir, "next");
    await Bun.write(
      join(tempDir, ".env.local"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_next\n",
    );
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_test_next", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ".env.local"),
    );
  });

  test("handles quoted values in .env files", async () => {
    await Bun.write(join(tempDir, ".env"), 'CLERK_PUBLISHABLE_KEY="pk_test_quoted"\n');
    expect(await findLinkKey(tempDir)).toEqual(
      found("pk_test_quoted", "CLERK_PUBLISHABLE_KEY", ".env"),
    );
  });

  test("skips empty values", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=\n");
    expect(await findLinkKey(tempDir)).toEqual({ status: "none" });
  });

  // The SDK keyless file is matched only for an SDK-only folder, by its own step.
  test("ignores the SDK keyless file's key", async () => {
    await Bun.write(
      join(tempDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({ publishableKey: "pk_test_sdk", secretKey: "sk_test_sdk" }),
    );
    expect(await findLinkKey(tempDir)).toEqual({ status: "none" });
  });
});

describe("matchKeyToApp", () => {
  test("matches by publishable key", () => {
    const keys = [{ key: "pk_test_abc", source: ".env.local" }];
    const result = matchKeyToApp(keys, mockApps);
    expect(result).toBeDefined();
    expect(result!.app.application_id).toBe("app_123");
    expect(result!.instance.instance_id).toBe("ins_dev");
  });

  test("matches production instance", () => {
    const keys = [{ key: "pk_live_abc", source: "env" }];
    const result = matchKeyToApp(keys, mockApps);
    expect(result).toBeDefined();
    expect(result!.app.application_id).toBe("app_123");
    expect(result!.instance.instance_id).toBe("ins_prod");
  });

  test("returns undefined when no match", () => {
    const keys = [{ key: "pk_test_unknown", source: "env" }];
    const result = matchKeyToApp(keys, mockApps);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty keys", () => {
    const result = matchKeyToApp([], mockApps);
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty apps", () => {
    const keys = [{ key: "pk_test_abc", source: "env" }];
    const result = matchKeyToApp(keys, []);
    expect(result).toBeUndefined();
  });

  test("returns first match when multiple keys match", () => {
    const keys = [
      { key: "pk_test_def", source: "env" },
      { key: "pk_test_abc", source: ".env" },
    ];
    const result = matchKeyToApp(keys, mockApps);
    expect(result!.app.application_id).toBe("app_456");
    expect(result!.source).toBe("env");
  });

  test("does not match by secret key", () => {
    const appsWithSecrets = [
      {
        application_id: "app_999",
        name: "Secret App",
        instances: [
          {
            instance_id: "ins_secret",
            environment_type: "development",
            secret_key: "sk_test_secret",
            publishable_key: "pk_test_secret",
          },
        ],
      },
    ];
    const keys = [{ key: "sk_test_secret", source: "env" }];
    const result = matchKeyToApp(keys, appsWithSecrets);
    expect(result).toBeUndefined();
  });
});

describe("autolink", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;
  let debugSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-autolink-test-"));
    _setConfigDir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.CLERK_PUBLISHABLE_KEY;
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";
    mockGetGitRepoIdentifier.mockReset();
    mockGetGitRepoIdentifier.mockResolvedValue(undefined);
    mockGetGitNormalizedRemote.mockReset();
    mockGetGitNormalizedRemote.mockResolvedValue(undefined);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    stubFetch(async () => new Response(JSON.stringify(mockApps), { status: 200 }));
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function runAutolink(cwd: string) {
    return autolink(cwd);
  }

  /** The result when it linked; fails the test otherwise. */
  function linked(result: Awaited<ReturnType<typeof autolink>>) {
    if (result.status !== "linked") throw new Error(`expected a link, got ${result.status}`);
    return result;
  }

  test("reports no key when no keys detected", async () => {
    expect(await runAutolink(tempDir)).toEqual({ status: "no_key" });
  });

  test("reports a failed app list when not authenticated, with the error", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    delete process.env.CLERK_PLATFORM_API_KEY;

    const result = await runAutolink(tempDir);
    expect(result.status).toBe("list_failed");
    expect(result.status === "list_failed" && result.error).toBeInstanceOf(Error);
  });

  test("reports a failed app list when the API returns an error", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));

    const result = await runAutolink(tempDir);
    expect(result.status).toBe("list_failed");
  });

  test("reports no match, naming the key's source, when the key matches no app", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_unknown";

    expect(await runAutolink(tempDir)).toEqual({
      status: "no_match",
      source: "CLERK_PUBLISHABLE_KEY env var",
    });
  });

  // Decided behavior: the matcher never falls back to a key the app doesn't load.
  test("Next.js: doesn't link .env's app when .env.local's key matches nothing", async () => {
    await writePackageJson(tempDir, "next");
    await Bun.write(join(tempDir, ".env"), "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc\n");
    await Bun.write(
      join(tempDir, ".env.local"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_unknown\n",
    );

    expect(await runAutolink(tempDir)).toEqual({ status: "no_match", source: ".env.local" });
    expect((await readConfig()).profiles[tempDir]).toBeUndefined();
  });

  test("reports couldn't tell, without listing apps, when the files disagree", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_abc\n");
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_def\n");
    let listed = false;
    stubFetch(async () => {
      listed = true;
      return new Response(JSON.stringify(mockApps), { status: 200 });
    });

    const result = await runAutolink(tempDir);

    expect(result.status).toBe("couldnt_tell");
    expect(listed).toBe(false);
    expect((await readConfig()).profiles[tempDir]).toBeUndefined();
  });

  test("auto-links when publishable key matches via env var", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    const result = linked(await runAutolink(tempDir));

    expect(result.profile.appId).toBe("app_123");
    expect(result.profile.instances.development).toBe("ins_dev");
    expect(result.profile.instances.production).toBe("ins_prod");

    // Verify profile was persisted
    const config = await readConfig();
    expect(config.profiles[tempDir]).toBeDefined();
    expect(config.profiles[tempDir]!.appId).toBe("app_123");
  });

  test("auto-links when publishable key matches via .env file", async () => {
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_def\n");

    const result = linked(await runAutolink(tempDir));

    expect(result.profile.appId).toBe("app_456");
    expect(result.profile.instances.development).toBe("ins_dev_2");
  });

  test("uses normalized remote as profile key when available", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");

    const result = linked(await runAutolink(tempDir));

    expect(result.path).toBe("github.com/org/repo");
    const config = await readConfig();
    expect(config.profiles["github.com/org/repo"]).toBeDefined();
  });

  test("uses git repo identifier when no remote", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    mockGetGitNormalizedRemote.mockResolvedValue(undefined);
    mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");

    const result = linked(await runAutolink(tempDir));

    expect(result.path).toBe("/repo/.git");
    const config = await readConfig();
    expect(config.profiles["/repo/.git"]).toBeDefined();
  });

  test("falls back to cwd when not in a git repo", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    const result = linked(await runAutolink(tempDir));

    expect(result.path).toBe(tempDir);
  });

  test("prints auto-link message to stderr", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    await runAutolink(tempDir);

    expect(captured.err).toContain("Auto-linked to");
    expect(captured.err).toContain("My App");
    expect(captured.err).toContain("CLERK_PUBLISHABLE_KEY env var");
  });

  test("returns undefined when matched app has no development instance", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_live_only";
    stubFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              application_id: "app_no_dev",
              instances: [
                {
                  instance_id: "ins_prod",
                  environment_type: "production",
                  publishable_key: "pk_live_only",
                },
              ],
            },
          ]),
          { status: 200 },
        ),
    );

    expect(await runAutolink(tempDir)).toEqual({
      status: "no_development_instance",
      appId: "app_no_dev",
    });
  });

  test("reports a failed app list for a non-array response from listApplications", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    stubFetch(async () => new Response(JSON.stringify({ error: "not an array" }), { status: 200 }));

    expect((await runAutolink(tempDir)).status).toBe("list_failed");
  });

  test("omits production instance when not present", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_def";

    const result = linked(await runAutolink(tempDir));

    expect(result.profile.instances.production).toBeUndefined();
  });
});
