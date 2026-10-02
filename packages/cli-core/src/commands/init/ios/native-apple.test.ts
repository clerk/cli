import { describe, expect, test } from "bun:test";
import { ERROR_CODE } from "../../../lib/errors.ts";
import type { InstanceConfigSchema } from "../../../lib/plapi.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  applyIOSNativeAppleConnection,
  auditIOSNativeAppleHealth,
  buildIOSNativeApplePlan,
  auditIOSNativeAppleConnection,
  type IOSNativeAppleAPI,
  type IOSNativeApplePatchOptions,
  type IOSNativeAppleReadAPI,
} from "./native-apple.ts";

const APPLICATION_ID = "app_native_apple";
const INSTANCE_ID = "ins_native_apple";
const BUNDLE_IDENTIFIER = "com.example.NativeApple";
const CONFIG_VERSION = "v1_1234abcd";
const NEXT_CONFIG_VERSION = "v1_9876fedc";
const SERVICES_ID = "com.example.web.sign-in";
const TEAM_ID = "APPLE_TEAM_ID_MUST_NOT_ESCAPE";
const KEY_ID = "APPLE_KEY_ID_MUST_NOT_ESCAPE";
const PRIVATE_KEY = "APPLE_PRIVATE_KEY_MUST_NOT_ESCAPE";
const API_SECRET = "Bearer ak_PLATFORM_TOKEN_MUST_NOT_ESCAPE";

const captured = useCaptureLog();

type AppleConnection = Record<string, unknown> & {
  enabled: boolean;
  authenticatable: boolean;
};

function appleSchema(): InstanceConfigSchema {
  return {
    type: "object",
    properties: {
      connection_oauth_apple: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          authenticatable: { type: "boolean" },
          client_id: { type: "string" },
          client_secret: { type: "string", "x-clerk-sensitive": true },
          team_id: { type: "string" },
          key_id: { type: "string" },
          bundle_id: { type: "string" },
        },
      },
    },
  };
}

function connection(
  enabled = false,
  authenticatable = true,
  extras: Record<string, unknown> = {},
): AppleConnection {
  return { enabled, authenticatable, ...extras };
}

function config(value: AppleConnection, configVersion: string | null = CONFIG_VERSION) {
  return {
    ...(configVersion ? { config_version: configVersion } : {}),
    connection_oauth_apple: { ...value },
  };
}

function baseOptions(
  overrides: Partial<Parameters<typeof auditIOSNativeAppleConnection>[0]> = {},
): Parameters<typeof auditIOSNativeAppleConnection>[0] {
  return {
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    nativeApplicationReady: true,
    ...overrides,
  };
}

type PatchCall = {
  config: Record<string, unknown>;
  options: IOSNativeApplePatchOptions;
};

function statefulAPI(
  options: {
    initial?: AppleConnection;
    schema?: InstanceConfigSchema;
    version?: string | null;
    failFetch?: unknown;
    failDryRun?: unknown;
    failActual?: unknown;
    malformedDryRun?: boolean;
    replaceProjection?: boolean;
    dryRunProjectionOverride?: Record<string, unknown>;
    actualProjectionOverride?: Record<string, unknown>;
    persistedActualState?: AppleConnection;
    persistActual?: boolean;
  } = {},
): {
  api: IOSNativeAppleAPI;
  calls: string[];
  patchCalls: PatchCall[];
  actualWrites(): number;
  current(): AppleConnection;
  setCurrent(value: AppleConnection): void;
  setVersion(value: string | undefined): void;
} {
  let current = {
    ...(options.initial ?? connection()),
  } as AppleConnection;
  let version: string | undefined =
    options.version === null ? undefined : (options.version ?? CONFIG_VERSION);
  let writes = 0;
  const calls: string[] = [];
  const patchCalls: PatchCall[] = [];

  const api: IOSNativeAppleAPI = {
    async fetchInstanceConfig(applicationId, instanceId, keys) {
      expect(applicationId).toBe(APPLICATION_ID);
      expect(instanceId).toBe(INSTANCE_ID);
      expect(keys).toEqual(["connection_oauth_apple"]);
      calls.push("GET config");
      if (options.failFetch) throw options.failFetch;
      return config(current, version ?? null);
    },
    async fetchInstanceConfigSchema(applicationId, instanceId, keys) {
      expect(applicationId).toBe(APPLICATION_ID);
      expect(instanceId).toBe(INSTANCE_ID);
      expect(keys).toEqual(["connection_oauth_apple"]);
      calls.push("GET schema");
      if (options.failFetch) throw options.failFetch;
      return options.schema ?? appleSchema();
    },
    async patchInstanceConfig(applicationId, instanceId, patch, patchOptions) {
      expect(applicationId).toBe(APPLICATION_ID);
      expect(instanceId).toBe(INSTANCE_ID);
      calls.push(patchOptions.dryRun ? "PATCH dry-run" : "PATCH apply");
      patchCalls.push({
        config: structuredClone(patch),
        options: { ...patchOptions },
      });

      if (patchOptions.ifMatch !== version) {
        throw new Error("config version conflict");
      }
      if (patchOptions.dryRun && options.failDryRun) throw options.failDryRun;
      if (!patchOptions.dryRun && options.failActual) throw options.failActual;

      const update = patch.connection_oauth_apple;
      if (typeof update !== "object" || update == null || Array.isArray(update)) {
        throw new Error("invalid test patch");
      }
      const before = { ...current };
      const after = (
        options.replaceProjection
          ? { ...(update as Record<string, unknown>) }
          : { ...current, ...(update as Record<string, unknown>) }
      ) as AppleConnection;
      const projectionOverride = patchOptions.dryRun
        ? options.dryRunProjectionOverride
        : options.actualProjectionOverride;
      if (projectionOverride) Object.assign(after, structuredClone(projectionOverride));
      if (patchOptions.dryRun && options.malformedDryRun) {
        return { config_version: version, dry_run: true, before: {}, after: {} };
      }
      if (!patchOptions.dryRun) {
        writes += 1;
        if (options.persistActual !== false) {
          current = options.persistedActualState
            ? structuredClone(options.persistedActualState)
            : after;
        }
        version = NEXT_CONFIG_VERSION;
      }
      return {
        config_version: patchOptions.dryRun ? version : NEXT_CONFIG_VERSION,
        dry_run: patchOptions.dryRun,
        before: { connection_oauth_apple: before },
        after: { connection_oauth_apple: after },
      };
    },
  };

  return {
    api,
    calls,
    patchCalls,
    actualWrites: () => writes,
    current: () => ({ ...current }),
    setCurrent(value) {
      current = { ...value };
    },
    setVersion(value) {
      version = value;
    },
  };
}

async function prepareReadyConnection(api: IOSNativeAppleAPI) {
  const plan = await auditIOSNativeAppleConnection(baseOptions(), api);
  if (plan.status !== "ready") throw new Error("expected ready plan");
  return plan;
}

describe("native Sign in with Apple remote setup", () => {
  test("audits runtime health through a credential-free GET-only projection", async () => {
    const calls: string[] = [];
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig(applicationId, instanceId, keys) {
        expect([applicationId, instanceId]).toEqual([APPLICATION_ID, INSTANCE_ID]);
        expect(keys).toEqual(["connection_oauth_apple"]);
        calls.push("GET config");
        return config(
          connection(true, true, {
            bundle_id: BUNDLE_IDENTIFIER,
            client_id: SERVICES_ID,
            client_secret: PRIVATE_KEY,
            team_id: TEAM_ID,
            key_id: KEY_ID,
          }),
        );
      },
      async fetchInstanceConfigSchema(applicationId, instanceId, keys) {
        expect([applicationId, instanceId]).toEqual([APPLICATION_ID, INSTANCE_ID]);
        expect(keys).toEqual(["connection_oauth_apple"]);
        calls.push("GET schema");
        return {};
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime).toEqual({
      status: "satisfied",
      connection: "satisfied",
      bundleIdentifierConfiguration: "satisfied",
      current: { enabled: true, authenticatable: true },
      blockers: [],
    });
    expect(result.automation).toMatchObject({
      status: "unsupported",
      configVersion: CONFIG_VERSION,
      blockers: [expect.objectContaining({ code: "apple-config-unsupported" })],
    });
    expect(result.automation.blockers.map((blocker) => blocker.message).join("\n")).not.toContain(
      "clerk init",
    );
    expect(calls.sort()).toEqual(["GET config", "GET schema"]);
    const serialized = JSON.stringify(result);
    for (const sensitive of [SERVICES_ID, PRIVATE_KEY, TEAM_ID, KEY_ID]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  test("reports repairable runtime state independently from supported automation", async () => {
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        return config(connection(false, true));
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime).toMatchObject({
      status: "required",
      connection: "required",
      bundleIdentifierConfiguration: "required",
      blockers: [],
    });
    expect(result.automation).toEqual({
      status: "supported",
      configVersion: CONFIG_VERSION,
      blockers: [],
    });
  });

  test("reports a case-only Bundle ID difference as a supported spelling repair", async () => {
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        return config(
          connection(true, true, {
            bundle_id: BUNDLE_IDENTIFIER.toLowerCase(),
          }),
        );
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime).toEqual({
      status: "required",
      connection: "required",
      bundleIdentifierConfiguration: "required",
      current: { enabled: true, authenticatable: true },
      blockers: [],
    });
    expect(result.automation).toEqual({
      status: "supported",
      configVersion: CONFIG_VERSION,
      blockers: [],
    });
  });

  test("requires a config version only when the health audit finds a repair", async () => {
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        return config(connection(false, true), null);
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime.status).toBe("required");
    expect(result.automation).toMatchObject({
      status: "unsupported",
      blockers: [expect.objectContaining({ code: "apple-config-version-unavailable" })],
    });
    expect(result.automation.configVersion).toBeUndefined();
    expect(result.automation.blockers.map((blocker) => blocker.message).join("\n")).not.toContain(
      "clerk init",
    );
  });

  test("keeps a healthy versionless connection supported when no repair is required", async () => {
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        return config(connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }), null);
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime.status).toBe("satisfied");
    expect(result.automation).toEqual({ status: "supported", blockers: [] });
  });

  test("keeps malformed automation metadata from poisoning healthy runtime state", async () => {
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        return config(
          connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
          `v1_${PRIVATE_KEY}`,
        );
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    const result = await auditIOSNativeAppleHealth(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        bundleIdentifier: BUNDLE_IDENTIFIER,
      },
      api,
    );

    expect(result.runtime.status).toBe("satisfied");
    expect(result.automation).toMatchObject({
      status: "unsupported",
      blockers: [expect.objectContaining({ code: "apple-config-invalid" })],
    });
    expect(result.automation.blockers.map((blocker) => blocker.message).join("\n")).not.toContain(
      "clerk init",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  test("preserves GET transport errors for diagnostic classification", async () => {
    const transportError = new Error(API_SECRET);
    const api: IOSNativeAppleReadAPI = {
      async fetchInstanceConfig() {
        throw transportError;
      },
      async fetchInstanceConfigSchema() {
        return appleSchema();
      },
    };

    await expect(
      auditIOSNativeAppleHealth(
        {
          applicationId: APPLICATION_ID,
          instanceId: INSTANCE_ID,
          bundleIdentifier: BUNDLE_IDENTIFIER,
        },
        api,
      ),
    ).rejects.toBe(transportError);
  });

  test("builds a narrow redacted plan without retaining web credentials", () => {
    const sensitiveConnection = connection(false, true, {
      client_id: SERVICES_ID,
      client_secret: PRIVATE_KEY,
      team_id: TEAM_ID,
      key_id: KEY_ID,
    });
    const plan = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      nativeApplicationReady: true,
      config: config(sensitiveConnection),
      schema: appleSchema(),
    });

    expect(plan).toMatchObject({
      status: "ready",
      connection: "required",
      bundleIdentifierConfiguration: "required",
      current: { enabled: false, authenticatable: true },
      desired: { enabled: true, authenticatable: true },
      configVersion: CONFIG_VERSION,
      blockers: [],
    });
    expect(plan.actions).toHaveLength(1);
    const serialized = JSON.stringify(plan);
    for (const sensitive of [SERVICES_ID, PRIVATE_KEY, TEAM_ID, KEY_ID]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  test.each([CONFIG_VERSION, null])(
    "keeps an already-satisfied connection read-only (config version=%s)",
    async (version) => {
      const harness = statefulAPI({
        initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
        version,
      });
      const plan = await auditIOSNativeAppleConnection(baseOptions(), harness.api);

      expect(plan.status).toBe("satisfied");
      if (plan.status !== "satisfied") throw new Error("expected satisfied plan");
      expect(harness.patchCalls).toHaveLength(0);
      await applyIOSNativeAppleConnection(plan, { api: harness.api });
      expect(harness.patchCalls).toHaveLength(0);
      expect(harness.actualWrites()).toBe(0);
      expect(harness.calls.filter((call) => call === "GET config")).toHaveLength(2);
      expect(harness.calls.filter((call) => call === "GET schema")).toHaveLength(2);
    },
  );

  test("revalidates caller-owned local state before accepting a no-op", async () => {
    const harness = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
    });
    const plan = await auditIOSNativeAppleConnection(baseOptions(), harness.api);
    if (plan.status !== "satisfied") throw new Error("expected satisfied plan");
    let revalidations = 0;

    await expect(
      applyIOSNativeAppleConnection(plan, {
        api: harness.api,
        revalidateLocalPreconditions: async () => {
          revalidations += 1;
          throw new Error("secondary platform identity changed");
        },
      }),
    ).rejects.toThrow("secondary platform identity changed");

    expect(revalidations).toBe(1);
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
  });

  test.each([false, true])(
    "revalidates a concurrently completed connection with stale local state: %s",
    async (stale) => {
      const harness = statefulAPI();
      const plan = await prepareReadyConnection(harness.api);
      harness.setCurrent(connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }));
      harness.setVersion(NEXT_CONFIG_VERSION);
      let revalidations = 0;
      const result = applyIOSNativeAppleConnection(plan, {
        api: harness.api,
        revalidateLocalPreconditions: async () => {
          revalidations += 1;
          if (stale) throw new Error("local target changed");
        },
      });
      if (stale) await expect(result).rejects.toThrow("local target changed");
      else await result;
      expect(revalidations).toBe(1);
      expect(harness.patchCalls).toHaveLength(0);
      expect(harness.calls).toEqual(["GET config", "GET schema", "GET config", "GET schema"]);
    },
  );

  test("normalizes a case-only Apple config difference to the registration's spelling", async () => {
    const harness = statefulAPI({
      initial: connection(true, true, { bundle_id: "com.example.nativeapple" }),
    });
    const plan = await auditIOSNativeAppleConnection(baseOptions(), harness.api);

    expect(plan).toMatchObject({
      status: "ready",
      bundleIdentifier: BUNDLE_IDENTIFIER,
      bundleIdentifierConfiguration: "required",
      blockers: [],
    });
    if (plan.status !== "ready") throw new Error("expected ready plan");
    await applyIOSNativeAppleConnection(plan, { api: harness.api });

    expect(harness.patchCalls).toHaveLength(2);
    expect(harness.patchCalls.map((call) => call.config)).toEqual([
      {
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      },
      {
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      },
    ]);
    expect(harness.actualWrites()).toBe(1);
    expect(harness.current().bundle_id).toBe(BUNDLE_IDENTIFIER);
  });

  test("rejects a satisfied plan when the connection changes after prepare", async () => {
    const harness = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
    });
    const plan = await auditIOSNativeAppleConnection(baseOptions(), harness.api);
    if (plan.status !== "satisfied") throw new Error("expected satisfied plan");

    harness.setCurrent(
      connection(false, true, {
        bundle_id: BUNDLE_IDENTIFIER,
        client_secret: PRIVATE_KEY,
      }),
    );

    let thrown: unknown;
    try {
      await applyIOSNativeAppleConnection(plan, { api: harness.api });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining("changed after the approved preview"),
    });
    expect(String(thrown)).not.toContain(PRIVATE_KEY);
    expect(captured.err).not.toContain(PRIVATE_KEY);
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.calls.filter((call) => call === "GET config")).toHaveLength(2);
    expect(harness.calls.filter((call) => call === "GET schema")).toHaveLength(2);
  });

  test("prepares before a planned native registration, then preserves web credentials on apply", async () => {
    const initial = connection(false, false, {
      client_id: SERVICES_ID,
      client_secret: "REDACTED",
      team_id: TEAM_ID,
      key_id: KEY_ID,
      unrelated_provider_setting: "keep-me",
    });
    const harness = statefulAPI({ initial });
    const prepared = await prepareReadyConnection(harness.api);
    expect(prepared.status).toBe("ready");
    // The exact iOS registration may still be an approved prerequisite here.
    // Server validation is intentionally deferred until apply, after the
    // registration transaction has run.
    expect(harness.patchCalls).toHaveLength(0);

    await applyIOSNativeAppleConnection(prepared, { api: harness.api });

    expect(harness.actualWrites()).toBe(1);
    expect(harness.patchCalls).toHaveLength(2);
    for (const call of harness.patchCalls) {
      expect(call.config).toEqual({
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      });
      expect(call.options.ifMatch).toBe(CONFIG_VERSION);
      expect(JSON.stringify(call.config)).not.toContain(SERVICES_ID);
      expect(JSON.stringify(call.config)).not.toContain(TEAM_ID);
      expect(JSON.stringify(call.config)).not.toContain(KEY_ID);
    }
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true, false]);
    expect(harness.current()).toEqual({
      ...initial,
      enabled: true,
      authenticatable: true,
      bundle_id: BUNDLE_IDENTIFIER,
    });
  });

  test("reuses the narrow native Apple connection path for a macOS target", async () => {
    const harness = statefulAPI();
    const prepared = await auditIOSNativeAppleConnection(
      baseOptions({ platform: "macos" }),
      harness.api,
    );

    expect(prepared).toMatchObject({ status: "ready", platform: "macos" });
    if (prepared.status !== "ready") throw new Error("expected ready plan");

    await applyIOSNativeAppleConnection(prepared, { api: harness.api });

    expect(harness.actualWrites()).toBe(1);
    expect(harness.patchCalls.map((call) => call.config)).toEqual([
      {
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      },
      {
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      },
    ]);
  });

  test("requires the exact native Bundle ID even when Apple is already authenticatable", async () => {
    const harness = statefulAPI({ initial: connection(true, true) });
    const prepared = await auditIOSNativeAppleConnection(baseOptions(), harness.api);

    expect(prepared).toMatchObject({
      status: "ready",
      connection: "required",
      bundleIdentifierConfiguration: "required",
    });
    expect(harness.patchCalls).toHaveLength(0);
  });

  test.each([
    {
      name: "the exact native application is not ready",
      nativeApplicationReady: false,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      value: connection(),
      schema: appleSchema(),
      blocker: "native-application-not-ready",
    },
    {
      name: "the Bundle ID is missing",
      nativeApplicationReady: true,
      bundleIdentifier: "  ",
      value: connection(),
      schema: appleSchema(),
      blocker: "bundle-identifier-unavailable",
    },
    {
      name: "the schema does not prove the exact native Bundle ID patch",
      nativeApplicationReady: true,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      value: connection(),
      schema: {
        type: "object",
        properties: {
          connection_oauth_apple: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              authenticatable: { type: "boolean" },
            },
          },
        },
      } as InstanceConfigSchema,
      blocker: "apple-config-unsupported",
    },
    {
      name: "the current config is malformed",
      nativeApplicationReady: true,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      value: { enabled: "yes", authenticatable: true } as unknown as AppleConnection,
      schema: appleSchema(),
      blocker: "apple-config-invalid",
    },
    {
      name: "Apple is enabled but deliberately not authenticatable",
      nativeApplicationReady: true,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      value: connection(true, false),
      schema: appleSchema(),
      blocker: "apple-authenticatable-conflict",
    },
    {
      name: "an existing Apple Bundle ID conflicts",
      nativeApplicationReady: true,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      value: connection(false, true, { bundle_id: "com.example.OtherApp" }),
      schema: appleSchema(),
      blocker: "apple-bundle-identifier-conflict",
    },
  ])("fails closed when $name", (fixture) => {
    const plan = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: fixture.bundleIdentifier,
      nativeApplicationReady: fixture.nativeApplicationReady,
      config: config(fixture.value),
      schema: fixture.schema,
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: fixture.blocker }));
  });

  test("fails before writing when the approved config version becomes stale", async () => {
    const harness = statefulAPI();
    const prepared = await prepareReadyConnection(harness.api);
    expect(prepared.status).toBe("ready");
    harness.setVersion(NEXT_CONFIG_VERSION);

    await expect(applyIOSNativeAppleConnection(prepared, { api: harness.api })).rejects.toThrow(
      "changed after the approved preview",
    );
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
  });

  test("rejects a serialized writable plan which is missing its configuration version", async () => {
    const harness = statefulAPI();
    const prepared = await prepareReadyConnection(harness.api);
    const incomplete = { ...prepared, configVersion: undefined };

    await expect(
      applyIOSNativeAppleConnection(incomplete, { api: harness.api }),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    });
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
  });

  test("requires a valid server dry-run projection before the actual write", async () => {
    const harness = statefulAPI({ malformedDryRun: true });
    const prepared = await prepareReadyConnection(harness.api);

    await expect(applyIOSNativeAppleConnection(prepared, { api: harness.api })).rejects.toThrow(
      "could not safely validate native Sign in with Apple",
    );
    expect(harness.actualWrites()).toBe(0);
  });

  test.each([
    {
      name: "drops existing Apple credential fields",
      options: {
        initial: connection(false, false, {
          client_id: SERVICES_ID,
          client_secret: PRIVATE_KEY,
          team_id: TEAM_ID,
          key_id: KEY_ID,
        }),
        replaceProjection: true,
      },
    },
    {
      name: "changes a nested preserved field",
      options: {
        initial: connection(false, false, {
          unrelated_provider_setting: { nested: { mode: "keep", secret: PRIVATE_KEY } },
        }),
        dryRunProjectionOverride: {
          unrelated_provider_setting: { nested: { mode: "changed", secret: PRIVATE_KEY } },
        },
      },
    },
  ])("rejects a dry-run projection that $name", async ({ options }) => {
    const harness = statefulAPI(options);
    const prepared = await prepareReadyConnection(harness.api);

    await expect(applyIOSNativeAppleConnection(prepared, { api: harness.api })).rejects.toThrow(
      "could not safely validate native Sign in with Apple",
    );
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true]);
    expect(harness.actualWrites()).toBe(0);
    expect(captured.err).not.toContain(PRIVATE_KEY);
  });

  test("revalidates caller-owned local state after preflight and before the actual write", async () => {
    const harness = statefulAPI({
      initial: connection(false, false),
    });
    const prepared = await prepareReadyConnection(harness.api);
    let revalidations = 0;

    await expect(
      applyIOSNativeAppleConnection(prepared, {
        api: harness.api,
        revalidateLocalPreconditions: async () => {
          revalidations += 1;
          throw new Error("secondary platform identity changed");
        },
      }),
    ).rejects.toThrow("secondary platform identity changed");

    expect(revalidations).toBe(1);
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true]);
    expect(harness.actualWrites()).toBe(0);
  });

  test("rejects an actual-write projection that changes a preserved credential value", async () => {
    const changedSecret = `${PRIVATE_KEY}_CHANGED`;
    const harness = statefulAPI({
      initial: connection(false, false, { client_secret: PRIVATE_KEY }),
      actualProjectionOverride: { client_secret: changedSecret },
    });
    const prepared = await prepareReadyConnection(harness.api);

    let thrown: unknown;
    try {
      await applyIOSNativeAppleConnection(prepared, { api: harness.api });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
      message: expect.stringContaining("removed or changed existing fields"),
    });
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true, false]);
    expect(harness.actualWrites()).toBe(1);
    expect(String(thrown)).not.toContain(PRIVATE_KEY);
    expect(String(thrown)).not.toContain(changedSecret);
    expect(captured.err).not.toContain(PRIVATE_KEY);
    expect(captured.err).not.toContain(changedSecret);
  });

  test("rejects a final state that drops a secret despite preserving projections", async () => {
    const initial = connection(false, true, {
      client_id: SERVICES_ID,
      client_secret: PRIVATE_KEY,
      unrelated_provider_setting: { nested: { mode: "keep" } },
    });
    const harness = statefulAPI({
      initial,
      persistedActualState: connection(true, true, {
        bundle_id: BUNDLE_IDENTIFIER,
        client_id: SERVICES_ID,
        unrelated_provider_setting: { nested: { mode: "keep" } },
      }),
    });
    const prepared = await prepareReadyConnection(harness.api);

    let thrown: unknown;
    try {
      await applyIOSNativeAppleConnection(prepared, { api: harness.api });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining("did not pass final verification"),
    });
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true, false]);
    expect(harness.actualWrites()).toBe(1);
    expect(String(thrown)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(prepared)).not.toContain(PRIVATE_KEY);
    expect(captured.err).not.toContain(PRIVATE_KEY);
  });

  test("rereads final state and rejects a write that did not persist", async () => {
    const harness = statefulAPI({ persistActual: false });
    const prepared = await prepareReadyConnection(harness.api);

    await expect(
      applyIOSNativeAppleConnection(prepared, { api: harness.api }),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining("did not pass final verification"),
    });
    expect(harness.actualWrites()).toBe(1);
    expect(harness.current().enabled).toBe(false);
  });

  test.each(["prepare", "recheck", "dry-run", "write", "final"])(
    "sanitizes %s failures and preserves their error classification",
    async (phase) => {
      const failure = new Error([API_SECRET, PRIVATE_KEY, TEAM_ID, KEY_ID, SERVICES_ID].join(" "));
      const failures: Parameters<typeof statefulAPI>[0] = {};
      const harness = statefulAPI(failures);
      const fetchConfig = harness.api.fetchInstanceConfig;
      harness.api.fetchInstanceConfig = async (...args) => {
        if (phase === "final" && harness.actualWrites() > 0) throw failure;
        return fetchConfig(...args);
      };
      const run = async () => {
        if (phase === "prepare") failures.failFetch = failure;
        const plan = await prepareReadyConnection(harness.api);
        if (phase === "recheck") failures.failFetch = failure;
        if (phase === "dry-run") failures.failDryRun = failure;
        if (phase === "write") failures.failActual = failure;
        await applyIOSNativeAppleConnection(plan, { api: harness.api });
      };
      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code:
          phase === "dry-run" || phase === "write"
            ? ERROR_CODE.IOS_REMOTE_APPLY_FAILED
            : ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      });
      if (phase === "final") {
        expect(caught).toMatchObject({
          message:
            "Native Sign in with Apple was submitted but its final Clerk state could not be verified. Rerun clerk init to inspect it safely.",
        });
      } else if (phase === "recheck") {
        expect(caught).toMatchObject({
          message:
            "Clerk Sign in with Apple settings could not be rechecked. No remote Apple connection changes were made; rerun clerk init.",
        });
      }
      expect(harness.actualWrites()).toBe(phase === "final" ? 1 : 0);
      const output = `${captured.err}\n${String(caught)}\n${JSON.stringify(caught)}`;
      expect(output).not.toMatch(/MUST_NOT_ESCAPE|com\.example\.web\.sign-in/);
    },
  );

  test("requires a config version for writes but allows a versionless no-op", () => {
    const withoutVersion = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      nativeApplicationReady: true,
      config: { connection_oauth_apple: connection() },
      schema: appleSchema(),
    });
    expect(withoutVersion.status).toBe("blocked");
    expect(withoutVersion.configVersion).toBeUndefined();
    expect(withoutVersion.blockers).toContainEqual(
      expect.objectContaining({ code: "apple-config-version-unavailable" }),
    );

    const satisfiedWithoutVersion = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      nativeApplicationReady: true,
      config: {
        connection_oauth_apple: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
      },
      schema: appleSchema(),
    });
    expect(satisfiedWithoutVersion.status).toBe("satisfied");

    const sensitiveVersion = `v1_${PRIVATE_KEY}`;
    const malformedVersion = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      nativeApplicationReady: true,
      config: config(connection(), sensitiveVersion),
      schema: appleSchema(),
    });
    expect(malformedVersion.status).toBe("blocked");
    expect(JSON.stringify(malformedVersion)).not.toContain(PRIVATE_KEY);
  });
});
