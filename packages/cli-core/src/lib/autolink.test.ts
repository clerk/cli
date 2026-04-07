import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialStoreStubs, gitStubs, stubFetch } from "../test/lib/stubs.ts";

mock.module("./credential-store.ts", () => credentialStoreStubs);

const mockGetGitRepoIdentifier = mock();
const mockGetGitNormalizedRemote = mock();
mock.module("./git.ts", () => ({
  ...gitStubs,
  getGitRepoIdentifier: (...args: unknown[]) => mockGetGitRepoIdentifier(...args),
  getGitNormalizedRemote: (...args: unknown[]) => mockGetGitNormalizedRemote(...args),
}));

const { findClerkKeys, matchKeyToApp, autolink } = await import("./autolink.ts");
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

describe("findClerkKeys", () => {
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

  test("returns empty when no keys found", async () => {
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([]);
  });

  test("detects CLERK_PUBLISHABLE_KEY from env var", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([{ key: "pk_test_abc", source: "CLERK_PUBLISHABLE_KEY env var" }]);
  });

  test("detects NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY from env var", async () => {
    await writePackageJson(tempDir, "next");
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_next";
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([
      { key: "pk_test_next", source: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY env var" },
    ]);
  });

  test("detects keys from .env.local file", async () => {
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_file\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([{ key: "pk_test_file", source: ".env.local" }]);
  });

  test("detects keys from .env file", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_dotenv\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([{ key: "pk_test_dotenv", source: ".env" }]);
  });

  test("prioritizes env vars over .env files", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_from_env";
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_from_file\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({ key: "pk_from_env", source: "CLERK_PUBLISHABLE_KEY env var" });
    expect(keys[1]).toEqual({ key: "pk_from_file", source: ".env.local" });
  });

  test("deduplicates identical keys across sources (last wins)", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_same";
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_same\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.source).toBe(".env.local");
  });

  test(".env.local overrides .env for the same key (last wins)", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_dotenv\n");
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_local\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toHaveLength(2);
    expect(keys[0]!.key).toBe("pk_dotenv");
    expect(keys[1]!.key).toBe("pk_local");
  });

  test("detects framework-specific publishable keys from .env files", async () => {
    await writePackageJson(tempDir, "next");
    await Bun.write(
      join(tempDir, ".env.local"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_next\n",
    );
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([{ key: "pk_test_next", source: ".env.local" }]);
  });

  test("handles quoted values in .env files", async () => {
    await Bun.write(join(tempDir, ".env"), 'CLERK_PUBLISHABLE_KEY="pk_test_quoted"\n');
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([{ key: "pk_test_quoted", source: ".env" }]);
  });

  test("skips empty values", async () => {
    await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=\n");
    const keys = await findClerkKeys(tempDir);
    expect(keys).toEqual([]);
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-autolink-test-"));
    _setConfigDir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.CLERK_PUBLISHABLE_KEY;
    process.env.CLERK_PLATFORM_API_KEY = "test_platform_key";
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

  test("returns undefined when no keys detected", async () => {
    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("returns undefined when not authenticated", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    delete process.env.CLERK_PLATFORM_API_KEY;

    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("returns undefined when API returns error", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));

    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("returns undefined when key doesn't match any app", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_unknown";

    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("auto-links when publishable key matches via env var", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    const result = await autolink(tempDir);

    expect(result).toBeDefined();
    expect(result!.profile.appId).toBe("app_123");
    expect(result!.profile.instances.development).toBe("ins_dev");
    expect(result!.profile.instances.production).toBe("ins_prod");

    // Verify profile was persisted
    const config = await readConfig();
    expect(config.profiles[tempDir]).toBeDefined();
    expect(config.profiles[tempDir]!.appId).toBe("app_123");
  });

  test("auto-links when publishable key matches via .env file", async () => {
    await Bun.write(join(tempDir, ".env.local"), "CLERK_PUBLISHABLE_KEY=pk_test_def\n");

    const result = await autolink(tempDir);

    expect(result).toBeDefined();
    expect(result!.profile.appId).toBe("app_456");
    expect(result!.profile.instances.development).toBe("ins_dev_2");
  });

  test("uses normalized remote as profile key when available", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");

    const result = await autolink(tempDir);

    expect(result!.path).toBe("github.com/org/repo");
    const config = await readConfig();
    expect(config.profiles["github.com/org/repo"]).toBeDefined();
  });

  test("uses git repo identifier when no remote", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    mockGetGitNormalizedRemote.mockResolvedValue(undefined);
    mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");

    const result = await autolink(tempDir);

    expect(result!.path).toBe("/repo/.git");
    const config = await readConfig();
    expect(config.profiles["/repo/.git"]).toBeDefined();
  });

  test("falls back to cwd when not in a git repo", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    const result = await autolink(tempDir);

    expect(result!.path).toBe(tempDir);
  });

  test("prints auto-link message to stderr", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";

    await autolink(tempDir);

    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Auto-linked to");
    expect(output).toContain("My App");
    expect(output).toContain("CLERK_PUBLISHABLE_KEY env var");
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

    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("handles non-array response from listApplications", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    stubFetch(async () => new Response(JSON.stringify({ error: "not an array" }), { status: 200 }));

    const result = await autolink(tempDir);
    expect(result).toBeUndefined();
  });

  test("omits production instance when not present", async () => {
    process.env.CLERK_PUBLISHABLE_KEY = "pk_test_def";

    const result = await autolink(tempDir);

    expect(result!.profile.instances.production).toBeUndefined();
  });
});
