import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitStubs, tokenExchangeStubs, stubFetch } from "../../test/stubs.ts";
import type { DoctorContext, ResolvedProfile } from "./types.ts";
import type { Application } from "../../lib/plapi.ts";

let mockUserInfo: { userId: string; email: string } | null = null;
let mockUserInfoError: Error | null = null;

mock.module("../../lib/token-exchange.ts", () => ({
  ...tokenExchangeStubs,
  fetchUserInfo: async () => {
    if (mockUserInfoError) throw mockUserInfoError;
    return mockUserInfo;
  },
}));

mock.module("../../lib/git.ts", () => gitStubs);

const {
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkGitAvailable,
  checkEnvVars,
  checkConfigFile,
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

function createMockContext(
  overrides: {
    token?: string | null;
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-doctor-test-"));
  process.cwd = () => tempDir;
  process.env = { ...originalEnv };
  process.env.CLERK_PLATFORM_API_KEY = "test_key";

  mockUserInfo = null;
  mockUserInfoError = null;

  stubFetch(async () => new Response(JSON.stringify(mockApplication), { status: 200 }));
});

afterEach(async () => {
  process.cwd = originalCwd;
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  await rm(tempDir, { recursive: true, force: true });
});

describe("checkLoggedIn", () => {
  test("pass when token exists", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkLoggedIn(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Token found");
  });

  test("fail when no token", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkLoggedIn(ctx);
    expect(result.status).toBe("fail");
    expect(result.remedy).toContain("clerk auth login");
    expect(result.fix).toBeDefined();
  });
});

describe("checkTokenValid", () => {
  test("pass with valid token", async () => {
    mockUserInfo = { userId: "user_1", email: "dev@example.com" };
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkTokenValid(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("dev@example.com");
  });

  test("fail when token is expired (401)", async () => {
    mockUserInfoError = new Error("Failed to fetch user info (401): Unauthorized");
    const ctx = createMockContext({ token: "expired_token" });
    const result = await checkTokenValid(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("expired or invalid");
    expect(result.remedy).toContain("clerk auth login");
    expect(result.fix).toBeDefined();
  });

  test("warn when network is unreachable", async () => {
    mockUserInfoError = new TypeError("fetch failed");
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkTokenValid(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("network issue");
    expect(result.detail).toContain("likely still valid");
    expect(result.fix).toBeUndefined();
  });

  test("warn+skip when no token", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkTokenValid(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Skipped");
  });
});

describe("checkProjectLinked", () => {
  test("pass when profile exists", async () => {
    const ctx = createMockContext({
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
    });
    const result = await checkProjectLinked(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("app_1");
    expect(result.message).toContain("via git remote");
  });

  test("fail when no profile", async () => {
    const ctx = createMockContext();
    const result = await checkProjectLinked(ctx);
    expect(result.status).toBe("fail");
    expect(result.remedy).toContain("clerk link");
    expect(result.fix).toBeDefined();
  });
});

describe("checkLinkedAppExists", () => {
  test("pass when app is accessible", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkLinkedAppExists(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("My App");
  });

  test("fail when app not found (404)", async () => {
    const { PlapiError } = await import("../../lib/plapi.ts");
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      applicationError: new PlapiError(404, "Not found"),
    });
    const result = await checkLinkedAppExists(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
    expect(result.fix).toBeDefined();
  });

  test("fail with generic error on non-404", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      applicationError: new Error("Connection timeout"),
    });
    const result = await checkLinkedAppExists(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("Could not verify application");
    expect(result.fix).toBeUndefined();
  });

  test("warn when not authenticated", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkLinkedAppExists(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Skipped");
  });

  test("warn when no project linked", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkLinkedAppExists(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Skipped");
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
    expect(result.status).toBe("pass");
    expect(result.message).toContain("ins_dev");
    expect(result.message).toContain("ins_prod");
  });

  test("warn when production not configured", async () => {
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkInstances(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("production not configured");
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
    expect(result.status).toBe("fail");
    expect(result.message).toContain("Stale");
    expect(result.message).toContain("ins_old");
    expect(result.fix).toBeDefined();
  });

  test("warn when not authenticated", async () => {
    const ctx = createMockContext({ token: null });
    const result = await checkInstances(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Skipped");
  });

  test("warn when no project linked", async () => {
    const ctx = createMockContext({ token: "test_token" });
    const result = await checkInstances(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Skipped");
  });
});

describe("checkGitAvailable", () => {
  test("pass when git is installed", async () => {
    const ctx = createMockContext();
    const result = await checkGitAvailable(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("git version");
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
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("CLERK_PUBLISHABLE_KEY");
    expect(result.message).toContain("development instance");
  });

  test("pass without environment label when app not available", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("CLERK_PUBLISHABLE_KEY");
    expect(result.message).toContain("CLERK_SECRET_KEY");
    expect(result.message).not.toContain("instance");
  });

  test("identifies environment via secret key when publishable key doesn't match", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test_unknown\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("development instance");
  });

  test("pass without environment label when neither key matches any instance", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=pk_test_unknown\nCLERK_SECRET_KEY=sk_test_unknown\n",
    );
    const ctx = createMockContext({
      token: "test_token",
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("instance");
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
      profile: {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      },
      application: mockApplication,
    });
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(result.message).toContain("development instance");
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
    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("instance");
  });

  test("falls back to .env when .env.local does not exist", async () => {
    await Bun.write(
      join(tempDir, ".env"),
      "CLERK_PUBLISHABLE_KEY=pk_test\nCLERK_SECRET_KEY=sk_test\n",
    );
    const ctx = createMockContext({ application: mockApplication });
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain(".env contains");
  });

  test("warn when keys missing", async () => {
    await Bun.write(join(tempDir, ".env.local"), "OTHER=value\n");
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("missing");
    expect(result.remedy).toContain("clerk env pull");
    expect(result.fix).toBeDefined();
  });

  test("warn when no env file", async () => {
    const ctx = createMockContext();
    const result = await checkEnvVars(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("No .env.local or .env file found");
    expect(result.fix).toBeDefined();
  });
});

describe("checkConfigFile", () => {
  test("pass when config is valid", async () => {
    process.env.CLERK_CONFIG_DIR = tempDir;
    await Bun.write(
      join(tempDir, "config.json"),
      JSON.stringify({ profiles: { "/a": {} }, auth: { userId: "u_1" } }),
    );
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("valid");
    expect(result.message).toContain("1 profile");
  });

  test("warn when config file does not exist", async () => {
    process.env.CLERK_CONFIG_DIR = join(tempDir, "nonexistent");
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("does not exist");
    expect(result.fix).toBeDefined();
  });

  test("fail when config has invalid JSON", async () => {
    process.env.CLERK_CONFIG_DIR = tempDir;
    await Bun.write(join(tempDir, "config.json"), "{ invalid json }");
    const ctx = createMockContext();
    const result = await checkConfigFile(ctx);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("failed to parse");
    expect(result.fix).toBeDefined();
  });
});
