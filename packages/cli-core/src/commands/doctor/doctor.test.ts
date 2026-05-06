import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError, AuthError } from "../../lib/errors.ts";
import { _setConfigDir } from "../../lib/config.ts";
import { gitStubs, tokenExchangeStubs, stubFetch } from "../../test/lib/stubs.ts";
import type { CheckResult, CheckStatus, DoctorContext, ResolvedProfile } from "./types.ts";
import type { Application } from "../../lib/plapi.ts";

let mockUserInfo: { userId: string; email: string } | null = null;
let mockUserInfoError: Error | null = null;
let mockHostStateProbe = {
  ok: true,
  failures: [] as Array<{ label: string; path: string; error: string }>,
};

mock.module("../../lib/token-exchange.ts", () => ({
  ...tokenExchangeStubs,
  fetchUserInfo: async () => {
    if (mockUserInfoError) throw mockUserInfoError;
    return mockUserInfo;
  },
}));

mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/host-execution.ts", () => ({
  getAgentHostStateProbe: async () => mockHostStateProbe,
  formatHostStateProbeFailures: (failures: Array<{ label: string; path: string; error: string }>) =>
    failures.map((failure) => `${failure.label}: ${failure.error} (${failure.path})`).join("\n"),
}));

const {
  checkHostExecution,
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
} = await import("./checks.ts");

const originalCwd = process.cwd;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let tempDir: string;

const mockApplication: Application = {
  application_id: "app_1",
  name: "My App",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_test",
      secret_key: "sk_test",
    },
    {
      instance_id: "ins_prod",
      environment_type: "production",
      publishable_key: "pk_live",
      secret_key: "sk_live",
    },
  ],
};

type Profile = {
  workspaceId: string;
  appId: string;
  instances: { development: string; production?: string };
};

const noopFix = () => ({ label: "noop", run: async () => {} });

const mockProfile = {
  path: "github.com/org/repo",
  profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
  resolvedVia: "remote" as const,
};

function createMockContext(
  overrides: {
    token?: string | null;
    validToken?: string | null | Error;
    profile?: {
      path: string;
      profile: Profile;
      resolvedVia: "remote" | "git-common-dir" | "directory";
    };
    application?: Application | null;
    applicationError?: Error;
  } = {},
): DoctorContext {
  return {
    getToken: async () => overrides.token ?? null,
    getValidToken: async () => {
      if (overrides.validToken instanceof Error) throw overrides.validToken;
      return overrides.validToken !== undefined ? overrides.validToken : (overrides.token ?? null);
    },
    getProfile: async () => overrides.profile as ResolvedProfile | undefined,
    getApplication: async () => {
      if (overrides.applicationError) throw overrides.applicationError;
      return overrides.application ?? null;
    },
    fixes: {
      login: noopFix,
      link: noopFix,
      envPull: noopFix,
    },
  };
}

interface ExpectedCheck {
  name: string;
  status: CheckStatus;
  message?: string | string[];
  messageNot?: string | string[];
  remedy?: string;
  detail?: string;
  fix?: boolean;
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function expectCheck(result: CheckResult, expected: ExpectedCheck) {
  expect(result.name).toBe(expected.name);
  expect(result.status).toBe(expected.status);

  for (const msg of toArray(expected.message)) {
    expect(result.message).toContain(msg);
  }
  for (const msg of toArray(expected.messageNot)) {
    expect(result.message).not.toContain(msg);
  }

  if (expected.remedy !== undefined) {
    expect(result.remedy).toContain(expected.remedy);
  }
  if (expected.detail !== undefined) {
    expect(result.detail).toContain(expected.detail);
  }
  if (expected.fix === true) {
    expect(result.fix).toBeDefined();
  } else if (expected.fix === false) {
    expect(result.fix).toBeUndefined();
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-doctor-test-"));
  process.cwd = () => tempDir;
  process.env = { ...originalEnv };
  delete process.env.FISH_VERSION;
  process.env.CLERK_PLATFORM_API_KEY = "test_key";

  mockUserInfo = null;
  mockUserInfoError = null;
  mockHostStateProbe = { ok: true, failures: [] };

  stubFetch(async () => new Response(JSON.stringify(mockApplication), { status: 200 }));
});

afterEach(async () => {
  process.cwd = originalCwd;
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  await rm(tempDir, { recursive: true, force: true });
});

describe("checkLoggedIn", () => {
  test("pass when token exists", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkLoggedIn(ctx);
    expectCheck(result, { name: "Logged in", status: "pass", message: "Logged in" });
  });

  test("fail when no token", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkLoggedIn(ctx);
    expectCheck(result, {
      name: "Logged in",
      status: "fail",
      remedy: "clerk auth login",
      fix: true,
    });
  });
});

describe("checkHostExecution", () => {
  test("pass when not in agent mode", async () => {
    process.env.CLERK_MODE = "human";
    const result = await checkHostExecution();
    expectCheck(result, {
      name: "Host execution",
      status: "pass",
      message: "Skipped (human mode)",
    });
  });

  test("pass when agent mode has writable host state", async () => {
    process.env.CLERK_MODE = "agent";
    mockHostStateProbe = { ok: true, failures: [] };

    const result = await checkHostExecution();
    expectCheck(result, {
      name: "Host execution",
      status: "pass",
      message: "writable in agent mode",
    });
  });

  test("warn when agent mode cannot write host state", async () => {
    process.env.CLERK_MODE = "agent";
    mockHostStateProbe = {
      ok: false,
      failures: [
        {
          label: "CLI config directory",
          path: "/Users/test/Library/Preferences/clerk-cli/.clerk-write-probe-1",
          error: "EPERM: operation not permitted",
        },
      ],
    };

    const result = await checkHostExecution();
    expectCheck(result, {
      name: "Host execution",
      status: "warn",
      message: "not writable in agent mode",
      remedy: "Re-run the command on the host shell",
      detail: "EPERM: operation not permitted",
      fix: false,
    });
  });
});

describe("checkTokenValid", () => {
  test("pass with valid token", async () => {
    mockUserInfo = { userId: "user_1", email: "dev@example.com" };
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkTokenValid(ctx);
    expectCheck(result, {
      name: "Authentication valid",
      status: "pass",
      message: "dev@example.com",
    });
  });

  test("fail when token is expired (401)", async () => {
    mockUserInfoError = new ApiError(401, "Unauthorized");
    const ctx = createMockContext({ token: "expired_token" });
    const result = await checkTokenValid(ctx);
    expectCheck(result, {
      name: "Authentication valid",
      status: "fail",
      message: "expired or invalid",
      remedy: "clerk auth login",
      fix: true,
    });
  });

  test("fail when refreshing the stored session requires re-authentication", async () => {
    const ctx = createMockContext({
      token: "expired_token",
      validToken: new AuthError({ reason: "session_expired" }),
    });
    const result = await checkTokenValid(ctx);
    expectCheck(result, {
      name: "Authentication valid",
      status: "fail",
      message: "expired or invalid",
      remedy: "clerk auth login",
      fix: true,
    });
  });

  test("warn when network is unreachable", async () => {
    mockUserInfoError = new TypeError("fetch failed");
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkTokenValid(ctx);
    expectCheck(result, {
      name: "Authentication valid",
      status: "warn",
      message: ["Could not reach Clerk", "network issue"],
      detail: "likely still valid",
      fix: false,
    });
  });

  test("warn+skip when no token", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkTokenValid(ctx);
    expectCheck(result, { name: "Authentication valid", status: "warn", message: "Skipped" });
  });
});

describe("checkProjectLinked", () => {
  test("pass when profile exists", async () => {
    const ctx = createMockContext({
      profile: mockProfile,
    });
    const result = await checkProjectLinked(ctx);
    expectCheck(result, {
      name: "Project linked",
      status: "pass",
      message: ["Linked", "via git remote"],
    });
  });

  test("fail when no profile", async () => {
    const ctx = createMockContext();
    const result = await checkProjectLinked(ctx);
    expectCheck(result, {
      name: "Project linked",
      status: "fail",
      remedy: "clerk link",
      fix: true,
    });
  });
});

describe("checkLinkedAppExists", () => {
  test("pass when app is reachable", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkLinkedAppExists(ctx);
    expectCheck(result, {
      name: "Application reachable",
      status: "pass",
      message: ["My App", "app_1", "is reachable"],
    });
  });

  test("fail when app not found (404)", async () => {
    const { PlapiError } = await import("../../lib/errors.ts");
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      applicationError: new PlapiError(404, "Not found"),
    });
    const result = await checkLinkedAppExists(ctx);
    expectCheck(result, {
      name: "Application reachable",
      status: "fail",
      message: "not found on Clerk",
      remedy: "doesn't exist or may have been deleted",
      fix: true,
    });
  });

  test("fail with generic error on non-404", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      applicationError: new Error("Connection timeout"),
    });
    const result = await checkLinkedAppExists(ctx);
    expectCheck(result, {
      name: "Application reachable",
      status: "fail",
      message: "Could not reach Clerk to verify application",
      fix: false,
    });
  });

  test("warn when not authenticated", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkLinkedAppExists(ctx);
    expectCheck(result, { name: "Application reachable", status: "warn", message: "Skipped" });
  });

  test("warn when no project linked", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkLinkedAppExists(ctx);
    expectCheck(result, { name: "Application reachable", status: "warn", message: "Skipped" });
  });
});

describe("checkInstances", () => {
  test("pass when dev and prod match API", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: {
          workspaceId: "org_1",
          appId: "app_1",
          instances: { development: "ins_dev", production: "ins_prod" },
        },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkInstances(ctx);
    expectCheck(result, {
      name: "Instance IDs",
      status: "pass",
      message: ["ins_dev", "ins_prod"],
    });
  });

  test("warn when production not configured", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkInstances(ctx);
    expectCheck(result, {
      name: "Instance IDs",
      status: "warn",
      message: "production not configured",
    });
  });

  test("fail when stored instance ID is stale", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_old" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkInstances(ctx);
    expectCheck(result, {
      name: "Instance IDs",
      status: "fail",
      message: ["mismatch", "ins_old", "not found in application"],
      fix: true,
    });
  });

  test("warn when not authenticated", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkInstances(ctx);
    expectCheck(result, { name: "Instance IDs", status: "warn", message: "Skipped" });
  });

  test("warn when no project linked", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkInstances(ctx);
    expectCheck(result, { name: "Instance IDs", status: "warn", message: "Skipped" });
  });
});

describe("checkEnvVars", () => {
  test("pass with environment label when keys match an instance", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      message: ["CLERK_PUBLISHABLE_KEY", "development instance"],
    });
  });

  test("pass without environment label when app not available", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      message: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
      messageNot: "instance",
    });
  });

  test("identifies environment via secret key when publishable key doesn't match", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test_unknown\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      message: "development instance",
    });
  });

  test("pass without environment label when neither key matches any instance", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test_unknown\nCLERK_SECRET_KEY=sk_test_unknown\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      messageNot: "instance",
    });
  });

  test("detects framework-specific key name for Next.js", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14" } }),
    );
    await Bun.write(
      join(tempDir, ".env.local"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: mockProfile,
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      message: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "development instance"],
    });
  });

  test("pass without environment label when getApplication throws", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({
      applicationError: new Error("Network timeout"),
    });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      messageNot: "instance",
    });
  });

  test("falls back to .env when .env.local does not exist", async () => {
    await Bun.write(
      join(tempDir, ".env"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({ application: mockApplication });
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "pass",
      message: ".env contains",
    });
  });

  test("warn when keys missing", async () => {
    await Bun.write(join(tempDir, ".env.local"), "OTHER=value\n");
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "warn",
      message: "missing",
      remedy: "clerk env pull",
      fix: true,
    });
  });

  test("warn when no env file", async () => {
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expectCheck(result, {
      name: "Environment variables",
      status: "warn",
      message: "No .env.local or .env file found",
      fix: true,
    });
  });
});

describe("checkConfigFile", () => {
  test("pass when config is valid", async () => {
    _setConfigDir(tempDir);
    await Bun.write(
      join(tempDir, "config.json"),
      JSON.stringify({ profiles: { "/a": {} }, auth: { userId: "u_1" } }),
    );
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expectCheck(result, {
      name: "CLI configuration",
      status: "pass",
      message: ["valid", "1 profile"],
    });
  });

  test("warn when config file does not exist", async () => {
    _setConfigDir(join(tempDir, "nonexistent"));
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expectCheck(result, {
      name: "CLI configuration",
      status: "warn",
      message: "does not exist",
      fix: true,
    });
  });

  test("fail when config has invalid JSON", async () => {
    _setConfigDir(tempDir);
    await Bun.write(join(tempDir, "config.json"), "{ invalid json }");
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expectCheck(result, {
      name: "CLI configuration",
      status: "fail",
      message: "failed to parse",
      fix: true,
    });
  });
});

describe("checkShellCompletion", () => {
  test("pass when shell cannot be detected", async () => {
    process.env.SHELL = "";
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "skipped",
    });
  });

  test("warn when zsh completion not installed", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      message: "zsh",
      remedy: "clerk completion zsh",
    });
  });

  test("pass when zsh completion is installed via zshrc", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = tempDir;
    await Bun.write(join(tempDir, ".zshrc"), 'eval "$(clerk completion zsh)"\n');
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "zsh",
    });
  });

  test("pass when zsh completion is installed via fpath", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = tempDir;
    await Bun.write(join(tempDir, ".zfunc/_clerk"), "#compdef clerk\n");
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "zsh",
    });
  });

  test("warn when bash completion not installed", async () => {
    process.env.SHELL = "/bin/bash";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      message: "bash",
      remedy: "clerk completion bash",
    });
  });

  test("pass when bash completion is in bashrc", async () => {
    process.env.SHELL = "/bin/bash";
    process.env.HOME = tempDir;
    await Bun.write(join(tempDir, ".bashrc"), 'eval "$(clerk completion bash)"\n');
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "bash",
    });
  });

  test("warn when fish completion file missing", async () => {
    process.env.SHELL = "/usr/bin/fish";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      message: "fish",
      remedy: "clerk completion fish",
    });
  });

  test("pass when fish completion file exists", async () => {
    process.env.SHELL = "/usr/bin/fish";
    process.env.HOME = tempDir;
    const fishDir = join(tempDir, ".config/fish/completions");
    await Bun.write(join(fishDir, "clerk.fish"), "# completion script\n");
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "fish",
    });
  });

  test("detects fish via FISH_VERSION when SHELL is unset", async () => {
    process.env.SHELL = "";
    process.env.FISH_VERSION = "3.7.0";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      message: "fish",
      remedy: "clerk completion fish",
    });
  });

  test("trusts SHELL over FISH_VERSION when SHELL is bash or zsh", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.FISH_VERSION = "3.7.0";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      message: "zsh",
      remedy: "clerk completion zsh",
    });
  });

  test("skips when SHELL points to an unrecognized shell", async () => {
    process.env.SHELL = "/bin/csh";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "pass",
      message: "skipped",
    });
  });

  test("no fix action attached (completions are not auto-fixable)", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expectCheck(result, {
      name: "Shell completion",
      status: "warn",
      fix: false,
    });
  });

  test("zsh remedy leads with the eval form (safe on fresh systems)", async () => {
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expect(result.remedy).toContain('eval "$(clerk completion zsh)"');
    // The raw fpath one-liner was unsafe — it fails when ~/.zfunc doesn't exist
    // and silently no-ops without fpath/compinit setup in ~/.zshrc.
    expect(result.remedy).not.toMatch(/clerk completion zsh > ~\/\.zfunc\/_clerk/);
  });

  test("fish remedy creates the completions directory before writing", async () => {
    process.env.SHELL = "/usr/bin/fish";
    process.env.HOME = tempDir;
    const result = await checkShellCompletion();
    expect(result.remedy).toContain("mkdir -p ~/.config/fish/completions");
  });
});
