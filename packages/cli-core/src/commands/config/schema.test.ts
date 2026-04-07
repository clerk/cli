import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configSchema } from "./schema.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const MOCK_SCHEMA = {
  type: "object",
  properties: {
    session: {
      type: "object",
      properties: { lifetime: { type: "integer" } },
    },
  },
};

type Ctx = {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
};

function depsFor({
  ctx = { appId: "app_1", appLabel: "app_1", instanceId: "ins_dev", instanceLabel: "development" },
  schema = MOCK_SCHEMA as Record<string, unknown>,
  resolveError,
  fetchError,
}: {
  ctx?: Ctx;
  schema?: Record<string, unknown>;
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
      fetchInstanceConfigSchema: async () => {
        if (fetchError) throw fetchError;
        return schema;
      },
    },
  });
}

describe("config schema", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-schema-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("errors when no profile is linked", async () => {
    const deps = depsFor({ resolveError: new Error("No Clerk project linked to this directory.") });
    await expect(configSchema(deps, {})).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    const deps = depsFor({ fetchError: new Error("Not authenticated. Run `clerk auth login`.") });
    await expect(configSchema(deps, {})).rejects.toThrow("Not authenticated");
  });

  test("prints schema JSON to stdout by default", async () => {
    const deps = depsFor();
    await configSchema(deps, {});
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(MOCK_SCHEMA, null, 2));
  });

  test("supports --app without a linked profile", async () => {
    const deps = depsFor();
    await configSchema(deps, { app: "app_1" });
    expect(deps.configStore.resolveAppContext).toHaveBeenCalledWith({ app: "app_1" });
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(MOCK_SCHEMA, null, 2));
  });

  test("writes schema to file with --output", async () => {
    const deps = depsFor();
    const outFile = join(tempDir, "schema.json");

    await configSchema(deps, { output: outFile });
    const written = await Bun.file(outFile).json();
    expect(written).toEqual(MOCK_SCHEMA);
    expect(deps.log.success).toHaveBeenCalledWith(expect.stringContaining("Schema written to"));
  });

  test("shows which environment is being pulled", async () => {
    const deps = depsFor();
    await configSchema(deps, {});
    expect(deps.log.info).toHaveBeenCalledWith("Pulling config schema from app_1 (development)...");
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
    await configSchema(deps, { instance: "prod" });
    expect(deps.log.info).toHaveBeenCalledWith("Pulling config schema from app_1 (production)...");
  });

  test("uses development instance by default", async () => {
    const deps = depsFor();
    await configSchema(deps, {});
    expect(deps.plapi.fetchInstanceConfigSchema).toHaveBeenCalledWith(
      "app_1",
      "ins_dev",
      undefined,
    );
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
    await configSchema(deps, { instance: "prod" });
    expect(deps.plapi.fetchInstanceConfigSchema).toHaveBeenCalledWith(
      "app_1",
      "ins_prod",
      undefined,
    );
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
    await configSchema(deps, { instance: "ins_custom_123" });
    expect(deps.plapi.fetchInstanceConfigSchema).toHaveBeenCalledWith(
      "app_1",
      "ins_custom_123",
      undefined,
    );
  });

  test("passes --keys to API as query params", async () => {
    const deps = depsFor();
    await configSchema(deps, { keys: ["session", "sign_up"] });
    expect(deps.plapi.fetchInstanceConfigSchema).toHaveBeenCalledWith("app_1", "ins_dev", [
      "session",
      "sign_up",
    ]);
  });

  test("errors when production instance not configured", async () => {
    const deps = depsFor({
      resolveError: new Error("No production instance configured. Run `clerk link` to set one up."),
    });
    await expect(configSchema(deps, { instance: "prod" })).rejects.toThrow(
      "No production instance configured",
    );
  });

  test("handles API errors gracefully", async () => {
    const deps = depsFor({ fetchError: new Error("API error: Unauthorized") });
    await expect(configSchema(deps, {})).rejects.toThrow("API error");
  });
});
