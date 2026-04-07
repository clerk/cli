import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pullDefault } from "./pull-default.ts";
import { testRoot } from "../../../test/lib/test-root.ts";
import type { Application } from "../../../lib/plapi.ts";

const MOCK_APP: Application = {
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

type Ctx = {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
};

interface DepsOpts {
  ctx?: Ctx;
  app?: Application;
  resolveError?: Error;
  fetchError?: Error;
}

function depsFor(opts: DepsOpts = {}) {
  const {
    ctx = {
      appId: "app_1",
      appLabel: "app_1",
      instanceId: "ins_dev",
      instanceLabel: "development",
    },
    app = MOCK_APP,
    resolveError,
    fetchError,
  } = opts;

  return testRoot({
    configStore: {
      resolveAppContext: async () => {
        if (resolveError) throw resolveError;
        return ctx;
      },
    },
    plapi: {
      fetchApplication: async () => {
        if (fetchError) throw fetchError;
        return app;
      },
    },
  });
}

describe("pullDefault", () => {
  const originalCwd = process.cwd;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-env-pull-test-"));
    // Write a default package.json so framework detection lands on the
    // CLERK_PUBLISHABLE_KEY/CLERK_SECRET_KEY fallback (express-style names).
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    process.cwd = () => tempDir;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("errors when no profile is linked", async () => {
    const deps = depsFor({
      resolveError: new Error("No Clerk project linked to this directory."),
    });
    await expect(pullDefault(deps)).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    const deps = depsFor({ fetchError: new Error("Not authenticated. Run `clerk auth login`.") });
    await expect(pullDefault(deps)).rejects.toThrow("Not authenticated");
  });

  test("creates .env.local with keys when no env file exists", async () => {
    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("updates existing .env.local preserving other vars", async () => {
    await Bun.write(join(tempDir, ".env.local"), "DB_URL=postgres://localhost\nAPP_NAME=myapp\n");

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("DB_URL=postgres://localhost");
    expect(content).toContain("APP_NAME=myapp");
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("updates existing Clerk keys in-place", async () => {
    await Bun.write(
      join(tempDir, ".env.local"),
      "CLERK_PUBLISHABLE_KEY=old_pk\nOTHER=val\nCLERK_SECRET_KEY=old_sk\n",
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toBe(
      "CLERK_PUBLISHABLE_KEY=pk_test_abc123\nOTHER=val\nCLERK_SECRET_KEY=sk_test_xyz789\n",
    );
  });

  test("falls back to .env when .env.local does not exist and .env has Clerk keys", async () => {
    await Bun.write(join(tempDir, ".env"), "EXISTING=value\nCLERK_SECRET_KEY=old_sk\n");

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("EXISTING=value");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
    // Should not have created .env.local since .env already had Clerk keys
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("falls back to .env when it contains NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );
    await Bun.write(
      join(tempDir, ".env"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=old_pk\nCLERK_SECRET_KEY=old_sk\n",
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("falls back to .env when it contains VITE_CLERK_PUBLISHABLE_KEY", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );
    await Bun.write(
      join(tempDir, ".env"),
      "VITE_CLERK_PUBLISHABLE_KEY=old_pk\nCLERK_SECRET_KEY=old_sk\n",
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("VITE_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("creates preferred file when .env exists but has no Clerk keys", async () => {
    await Bun.write(join(tempDir, ".env"), "EXISTING=value\n");

    const deps = depsFor();
    await pullDefault(deps);

    // Express prefers .env.local; .env exists but has no Clerk keys,
    // so keys go to the preferred file
    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("uses --file flag to target specific file", async () => {
    const deps = depsFor();
    await pullDefault(deps, { file: ".env.development" });

    const content = await Bun.file(join(tempDir, ".env.development")).text();
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("uses --instance prod to target production", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_prod",
        instanceLabel: "production",
      },
    });
    await pullDefault(deps, { instance: "prod" });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_live_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_live_xyz789");
  });

  test("uses --app without a linked profile", async () => {
    const deps = depsFor();
    await pullDefault(deps, { app: "app_1" });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("shows instance label in status message", async () => {
    const deps = depsFor();
    await pullDefault(deps);
    expect(deps.spinner.withSpinner).toHaveBeenCalledWith(
      expect.stringContaining("Pulling env vars from development instance"),
      expect.any(Function),
    );
  });

  test("shows written file in status message", async () => {
    const deps = depsFor();
    await pullDefault(deps);
    expect(deps.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Environment variables written to"),
    );
  });

  test("errors when instance not found in API response", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_unknown",
        instanceLabel: "development",
      },
    });
    await expect(pullDefault(deps)).rejects.toThrow("Instance ins_unknown not found");
  });

  test("handles API errors gracefully", async () => {
    const deps = depsFor({ fetchError: new Error("API error: Unauthorized") });
    await expect(pullDefault(deps)).rejects.toThrow("API error");
  });

  test("calls fetchApplication with the resolved app id", async () => {
    const deps = depsFor();
    await pullDefault(deps);
    expect(deps.plapi.fetchApplication).toHaveBeenCalledWith("app_1");
  });

  test("omits CLERK_SECRET_KEY when API does not return it", async () => {
    const appWithoutSecret: Application = {
      application_id: "app_1",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_abc123",
        },
      ],
    };
    const deps = depsFor({ app: appWithoutSecret });
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).not.toContain("CLERK_SECRET_KEY");
  });

  test("detects Next.js and uses NEXT_PUBLIC_* key name", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );

    const deps = depsFor();
    await pullDefault(deps);

    // Next.js prefers .env (gitignored by create-next-app via .env* pattern)
    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("Next.js writes to existing .env.local if it already has Clerk keys", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "16.0.0" } }),
    );
    // Simulate a project that already ran env pull before this change
    await Bun.write(
      join(tempDir, ".env.local"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=old_pk\nCLERK_SECRET_KEY=old_sk\n",
    );

    const deps = depsFor();
    await pullDefault(deps);

    // Should update .env.local (backwards compat) not create .env
    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_xyz789");
  });

  test("Nuxt writes to .env", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "4.0.0" } }),
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(await Bun.file(join(tempDir, ".env.local")).exists()).toBe(false);
  });

  test("Vite React writes to .env.local", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("VITE_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(await Bun.file(join(tempDir, ".env")).exists()).toBe(false);
  });

  test("detects Nuxt and uses NUXT_CLERK_SECRET_KEY", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "4.0.0" } }),
    );

    const deps = depsFor();
    await pullDefault(deps);

    const content = await Bun.file(join(tempDir, ".env")).text();
    expect(content).toContain("NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc123");
    expect(content).toContain("NUXT_CLERK_SECRET_KEY=sk_test_xyz789");
    expect(content).not.toMatch(/^CLERK_SECRET_KEY=/m);
  });
});
