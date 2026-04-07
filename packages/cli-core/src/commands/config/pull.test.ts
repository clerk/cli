import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPull } from "./pull.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const MOCK_CONFIG = {
  session: { lifetime: 604800 },
  sign_up: { mode: "public" },
};

type Ctx = {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
};

function depsFor({
  ctx = { appId: "app_1", appLabel: "app_1", instanceId: "ins_dev", instanceLabel: "development" },
  config = MOCK_CONFIG as Record<string, unknown>,
  resolveError,
  fetchError,
}: {
  ctx?: Ctx;
  config?: Record<string, unknown>;
  resolveError?: Error;
  fetchError?: Error;
} = {}) {
  return testRoot({
    configStore: {
      resolveAppContext: async () => {
        if (resolveError) throw resolveError;
        return ctx;
      },
    },
    plapi: {
      fetchInstanceConfig: async () => {
        if (fetchError) throw fetchError;
        return config;
      },
    },
  });
}

describe("config pull", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-pull-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("errors when no profile is linked", async () => {
    const deps = depsFor({ resolveError: new Error("No Clerk project linked to this directory.") });
    await expect(configPull(deps, {})).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    const deps = depsFor({ fetchError: new Error("Not authenticated. Run `clerk auth login`.") });
    await expect(configPull(deps, {})).rejects.toThrow("Not authenticated");
  });

  test("prints config JSON to stdout by default", async () => {
    const deps = depsFor();
    await configPull(deps, {});
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(MOCK_CONFIG, null, 2));
  });

  test("supports --app without a linked profile", async () => {
    const deps = depsFor();
    await configPull(deps, { app: "app_1" });
    expect(deps.configStore.resolveAppContext).toHaveBeenCalledWith({ app: "app_1" });
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(MOCK_CONFIG, null, 2));
  });

  test("writes config to file with --output", async () => {
    const deps = depsFor();
    const outFile = join(tempDir, "output.json");

    await configPull(deps, { output: outFile });
    const written = await Bun.file(outFile).json();
    expect(written).toEqual(MOCK_CONFIG);
    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining("Config written to"));
  });

  test("shows which environment is being pulled", async () => {
    const deps = depsFor();
    await configPull(deps, {});
    expect(deps.spinner.withSpinner).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from app_1 (development)"),
      expect.any(Function),
    );
  });

  test("shows app name when stored in profile", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "My SaaS App",
        instanceId: "ins_dev",
        instanceLabel: "development",
      },
    });
    await configPull(deps, {});
    expect(deps.spinner.withSpinner).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from My SaaS App (development)"),
      expect.any(Function),
    );
  });

  test("shows production label when --instance prod", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_prod",
        instanceLabel: "production",
      },
    });
    await configPull(deps, { instance: "prod" });
    expect(deps.spinner.withSpinner).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from app_1 (production)"),
      expect.any(Function),
    );
  });

  test("uses development instance by default", async () => {
    const deps = depsFor();
    await configPull(deps, {});
    expect(deps.plapi.fetchInstanceConfig).toHaveBeenCalledWith("app_1", "ins_dev", undefined);
  });

  test("--instance prod targets production instance", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_prod",
        instanceLabel: "production",
      },
    });
    await configPull(deps, { instance: "prod" });
    expect(deps.plapi.fetchInstanceConfig).toHaveBeenCalledWith("app_1", "ins_prod", undefined);
  });

  test("--instance with literal ID passes through", async () => {
    const deps = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_custom_123",
        instanceLabel: "ins_custom_123",
      },
    });
    await configPull(deps, { instance: "ins_custom_123" });
    expect(deps.plapi.fetchInstanceConfig).toHaveBeenCalledWith(
      "app_1",
      "ins_custom_123",
      undefined,
    );
  });

  test("errors when production instance not configured", async () => {
    const deps = depsFor({
      resolveError: new Error("No production instance configured. Run `clerk link` to set one up."),
    });
    await expect(configPull(deps, { instance: "prod" })).rejects.toThrow(
      "No production instance configured",
    );
  });

  test("--keys passes keys as query params to the API", async () => {
    const deps = depsFor({ config: { session: { lifetime: 604800 } } });
    await configPull(deps, { keys: ["session"] });
    expect(deps.plapi.fetchInstanceConfig).toHaveBeenCalledWith("app_1", "ins_dev", ["session"]);
    expect(deps.log.data).toHaveBeenCalledWith(
      JSON.stringify({ session: { lifetime: 604800 } }, null, 2),
    );
  });

  test("--keys passes multiple keys as repeated query params", async () => {
    const deps = depsFor();
    await configPull(deps, { keys: ["session", "sign_up"] });
    expect(deps.plapi.fetchInstanceConfig).toHaveBeenCalledWith("app_1", "ins_dev", [
      "session",
      "sign_up",
    ]);
  });

  test("handles API errors gracefully", async () => {
    const deps = depsFor({ fetchError: new Error("API error: Unauthorized") });
    await expect(configPull(deps, {})).rejects.toThrow("API error");
  });
});
