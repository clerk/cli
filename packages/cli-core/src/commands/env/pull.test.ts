import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialStoreStubs, gitStubs, configStubs, stubFetch } from "../../test/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);

type Profile = { workspaceId: string; appId: string; instances: Record<string, string> };
const _profiles: Record<string, Profile> = {};
const INSTANCE_ALIASES: Record<string, string> = {
  dev: "development",
  development: "development",
  prod: "production",
  production: "production",
};

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setProfile: async (path: string, profile: Profile) => {
    _profiles[path] = profile;
  },
  resolveProfile: async (cwd: string) => {
    if (_profiles[cwd])
      return { path: cwd, profile: _profiles[cwd], resolvedVia: "directory" as const };
    return undefined;
  },
  resolveInstanceId: (profile: Profile, flag?: string) => {
    if (!flag) return { id: profile.instances.development, label: "development" };
    const env = INSTANCE_ALIASES[flag];
    if (!env) return { id: flag, label: flag };
    const id = profile.instances[env];
    if (!id) throw new Error(`No ${env} instance configured. Run \`clerk link\` to set one up.`);
    return { id, label: env };
  },
  resolveAppContext: async (options: { app?: string; instance?: string }) => {
    if (options.app) {
      const app = {
        application_id: "app_1",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_abc123",
            secret_key: "sk_test_xyz789",
          },
          {
            instance_id: "ins_prod",
            environment_type: "production",
            publishable_key: "pk_live_abc123",
            secret_key: "sk_live_xyz789",
          },
        ],
      };
      if (options.instance) {
        const env = INSTANCE_ALIASES[options.instance];
        if (env) {
          const matched = app.instances.find((i) => i.environment_type === env);
          if (!matched) throw new Error(`No ${env} instance found for application ${options.app}.`);
          return { appId: options.app, instanceId: matched.instance_id, instanceLabel: env };
        }
        return {
          appId: options.app,
          instanceId: options.instance,
          instanceLabel: options.instance,
        };
      }
      return { appId: options.app, instanceId: "ins_dev", instanceLabel: "development" };
    }

    const profile = _profiles[process.cwd()];
    if (!profile) throw new Error("No Clerk project linked");
    const instance = !options.instance
      ? { id: profile.instances.development, label: "development" }
      : (() => {
          const env = INSTANCE_ALIASES[options.instance];
          if (!env) return { id: options.instance, label: options.instance };
          const id = profile.instances[env];
          if (!id)
            throw new Error(`No ${env} instance configured. Run \`clerk link\` to set one up.`);
          return { id, label: env };
        })();

    return { appId: profile.appId, instanceId: instance.id, instanceLabel: instance.label };
  },
}));

const { _setConfigDir, setProfile } = (await import("../../lib/config.ts")) as any;

describe("env pull", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd;
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const mockApplication = {
    application_id: "app_1",
    instances: [
      {
        instance_id: "ins_dev",
        environment_type: "development",
        publishable_key: "pk_test_abc123",
        secret_key: "sk_test_xyz789",
      },
      {
        instance_id: "ins_prod",
        environment_type: "production",
        publishable_key: "pk_live_abc123",
        secret_key: "sk_live_xyz789",
      },
    ],
  };

  beforeEach(async () => {
    Object.keys(_profiles).forEach((k) => delete _profiles[k]);
    tempDir = await mkdtemp(join(tmpdir(), "clerk-env-pull-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    // Write a package.json so framework detection works (fallback)
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );

    // Mock cwd to tempDir so file resolution works
    process.cwd = () => tempDir;

    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async () => new Response(JSON.stringify(mockApplication), { status: 200 }));
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    process.cwd = originalCwd;
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runEnvPull(options: { app?: string; instance?: string; file?: string } = {}) {
    const { pull } = await import("./pull.ts");
    return pull(options);
  }

  test("errors when no profile is linked", async () => {
    await expect(runEnvPull()).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runEnvPull()).rejects.toThrow("Not authenticated");
  });

  test("creates .env.local with keys when no env file exists", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("updates existing .env.local preserving other vars", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    await Bun.write(join(tempDir, ".env.local"), "DB_URL=postgres://localhost\nAPP_NAME=myapp\n");

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("DB_URL=postgres://localhost");
    expect(content).toContain("APP_NAME=myapp");
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("updates existing Clerk keys in-place", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=old_pk\nOTHER=val\nCLERK_SECRET_KEY=old_sk\n",
    );

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toBe(
      "CLERK_PUBLISHABLE_KEY=pk_test_abc123\nOTHER=val\nCLERK_SECRET_KEY=sk_test_xyz789\n",
    );
  });

  test("falls back to .env when .env.local does not exist", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    await Bun.write(join(tempDir, ".env"), "EXISTING=value\n");

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("EXISTING=value");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
    // Should not have created .env.local
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("uses --file flag to target specific file", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull({ file: ".env.development" });

    const content = await Bun.file(join(tempDir, ".env.development")).text();
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("uses --instance prod to target production", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runEnvPull({ instance: "prod" });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_live_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_live_xyz789");
  });

  test("uses --app without a linked profile", async () => {
    await runEnvPull({ app: "app_1" });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("shows instance label in status message", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull();
    expect(errorSpy).toHaveBeenCalledWith("Pulling env vars from development instance...");
  });

  test("shows written file in status message", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Environment variables written to"),
    );
  });

  test("errors when instance not found in API response", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_unknown" },
    });

    await expect(runEnvPull()).rejects.toThrow("Instance ins_unknown not found");
  });

  test("handles API errors gracefully", async () => {
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));

    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runEnvPull()).rejects.toThrow("API error");
  });

  test("sends include_secret_keys=true in API request", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockApplication), { status: 200 });
    });

    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull();
    expect(requestedUrl).toContain("include_secret_keys=true");
  });

  test("omits CLERK_SECRET_KEY when API does not return it", async () => {
    const appWithoutSecret = {
      application_id: "app_1",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_abc123",
        },
      ],
    };
    stubFetch(async () => new Response(JSON.stringify(appWithoutSecret), { status: 200 }));

    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).not.toContain("CLERK_SECRET_KEY");
  });

  test("detects Next.js and uses NEXT_PUBLIC_* key name", async () => {
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );

    await runEnvPull();

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
  });
});
