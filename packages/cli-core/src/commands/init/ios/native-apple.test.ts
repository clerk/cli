import { describe, expect, test } from "bun:test";
import { UserAbortError } from "../../../lib/errors.ts";
import type { InstanceConfigSchema } from "../../../lib/plapi.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  applyIOSNativeAppleConnection,
  auditIOSNativeAppleHealth,
  buildIOSNativeApplePlan,
  prepareIOSNativeAppleConnection,
  type IOSNativeAppleAPI,
  type IOSNativeApplePatchOptions,
  type IOSNativeApplePrompts,
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

function config(value: AppleConnection, configVersion: string | undefined = CONFIG_VERSION) {
  return {
    ...(configVersion ? { config_version: configVersion } : {}),
    connection_oauth_apple: { ...value },
  };
}

function baseOptions(
  overrides: Partial<Parameters<typeof prepareIOSNativeAppleConnection>[0]> = {},
): Parameters<typeof prepareIOSNativeAppleConnection>[0] {
  return {
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    nativeApplicationReady: true,
    requested: true,
    agent: false,
    yes: true,
    ...overrides,
  };
}

function unexpectedPrompts(overrides: Partial<IOSNativeApplePrompts> = {}): IOSNativeApplePrompts {
  return {
    enableNativeApple:
      overrides.enableNativeApple ??
      (async () => {
        throw new Error("unexpected Apple opt-in prompt");
      }),
    confirmChanges:
      overrides.confirmChanges ??
      (async () => {
        throw new Error("unexpected Apple mutation prompt");
      }),
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
    supportsIfMatch?: boolean;
    version?: string | undefined;
    failFetch?: unknown;
    failDryRun?: unknown;
    failActual?: unknown;
    malformedDryRun?: boolean;
    replaceProjection?: boolean;
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
    options.version === undefined ? CONFIG_VERSION : options.version;
  let writes = 0;
  const calls: string[] = [];
  const patchCalls: PatchCall[] = [];

  const api: IOSNativeAppleAPI = {
    supportsIfMatch: options.supportsIfMatch ?? false,
    async fetchInstanceConfig(applicationId, instanceId, keys) {
      expect(applicationId).toBe(APPLICATION_ID);
      expect(instanceId).toBe(INSTANCE_ID);
      expect(keys).toEqual(["connection_oauth_apple"]);
      calls.push("GET config");
      if (options.failFetch) throw options.failFetch;
      return config(current, version);
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

      if (patchOptions.ifMatch && patchOptions.ifMatch !== version) {
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
      if (patchOptions.dryRun && options.malformedDryRun) {
        return { config_version: version, dry_run: true, before: {}, after: {} };
      }
      if (!patchOptions.dryRun) {
        writes += 1;
        if (options.persistActual !== false) current = after;
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

  test("treats an existing enabled and authenticatable connection as a no-op", async () => {
    const harness = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
    });
    const plan = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });

    expect(plan.status).toBe("satisfied");
    expect(harness.patchCalls).toHaveLength(0);
    if (plan.status === "satisfied") {
      await applyIOSNativeAppleConnection(plan, harness.api);
    }
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.calls.filter((call) => call === "GET config")).toHaveLength(2);
    expect(harness.calls.filter((call) => call === "GET schema")).toHaveLength(2);
    expect(captured.err).toContain("already enabled");
  });

  test("rejects a satisfied plan when the connection changes after prepare", async () => {
    const harness = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
    });
    const plan = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    if (plan.status !== "satisfied") throw new Error("expected satisfied plan");

    harness.setCurrent(
      connection(false, true, {
        bundle_id: BUNDLE_IDENTIFIER,
        client_secret: PRIVATE_KEY,
      }),
    );

    let thrown: unknown;
    try {
      await applyIOSNativeAppleConnection(plan, harness.api);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("changed after the approved preview");
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
    const harness = statefulAPI({
      initial,
      supportsIfMatch: true,
    });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready plan");
    // The exact iOS registration may still be an approved prerequisite here.
    // Server validation is intentionally deferred until apply, after the
    // registration transaction has run.
    expect(harness.patchCalls).toHaveLength(0);

    await applyIOSNativeAppleConnection(prepared, harness.api);

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

  test("uses config-version rereads when an injected transport cannot send If-Match", async () => {
    const harness = statefulAPI({ supportsIfMatch: false });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });

    expect(prepared.status).toBe("ready");
    expect(harness.patchCalls).toHaveLength(0);
    if (prepared.status !== "ready") throw new Error("expected ready plan");

    await applyIOSNativeAppleConnection(prepared, harness.api);

    expect(harness.actualWrites()).toBe(1);
    expect(harness.patchCalls).toHaveLength(2);
    for (const call of harness.patchCalls) expect(call.options.ifMatch).toBeUndefined();

    const staleHarness = statefulAPI({ supportsIfMatch: false });
    const stalePrepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: staleHarness.api,
      prompts: unexpectedPrompts(),
    });
    if (stalePrepared.status !== "ready") throw new Error("expected ready plan");
    staleHarness.setVersion(NEXT_CONFIG_VERSION);

    await expect(applyIOSNativeAppleConnection(stalePrepared, staleHarness.api)).rejects.toThrow(
      "changed after the approved preview",
    );
    expect(staleHarness.patchCalls).toHaveLength(0);
    expect(staleHarness.actualWrites()).toBe(0);
  });

  test("requires the exact native Bundle ID even when Apple is already authenticatable", async () => {
    const harness = statefulAPI({ initial: connection(true, true) });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });

    expect(prepared).toMatchObject({
      status: "ready",
      connection: "required",
      bundleIdentifierConfiguration: "required",
    });
    expect(harness.patchCalls).toHaveLength(0);
  });

  test("keeps global --yes from opting an agent into Apple", async () => {
    const harness = statefulAPI();
    const prepared = await prepareIOSNativeAppleConnection(
      baseOptions({ requested: undefined, agent: true, yes: true }),
      { api: harness.api, prompts: unexpectedPrompts() },
    );

    expect(prepared).toEqual({
      schemaVersion: 1,
      kind: "clerk-ios-native-apple-connection",
      status: "skipped",
      reason: "not-requested",
    });
    expect(harness.calls).toEqual([]);
  });

  test("lets a human decline the opt-in before any remote read", async () => {
    const harness = statefulAPI();
    let optInCalls = 0;
    const prepared = await prepareIOSNativeAppleConnection(
      baseOptions({ requested: undefined, yes: true }),
      {
        api: harness.api,
        prompts: unexpectedPrompts({
          enableNativeApple: async (bundleIdentifier) => {
            optInCalls += 1;
            expect(bundleIdentifier).toBe(BUNDLE_IDENTIFIER);
            return false;
          },
        }),
      },
    );

    expect(prepared.status).toBe("skipped");
    expect(optInCalls).toBe(1);
    expect(harness.calls).toEqual([]);
  });

  test("requires separate human mutation consent without calling the mutation endpoint", async () => {
    const harness = statefulAPI();
    let consentCalls = 0;

    await expect(
      prepareIOSNativeAppleConnection(baseOptions({ yes: false }), {
        api: harness.api,
        prompts: unexpectedPrompts({
          confirmChanges: async () => {
            consentCalls += 1;
            return false;
          },
        }),
      }),
    ).rejects.toBeInstanceOf(UserAbortError);

    expect(consentCalls).toBe(1);
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
  });

  test("requires --yes for an explicitly requested agent mutation", async () => {
    const harness = statefulAPI();

    await expect(
      prepareIOSNativeAppleConnection(baseOptions({ agent: true, yes: false }), {
        api: harness.api,
        prompts: unexpectedPrompts(),
      }),
    ).rejects.toThrow("requires explicit mutation consent");

    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
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
    const harness = statefulAPI({ supportsIfMatch: true });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready plan");
    harness.setVersion(NEXT_CONFIG_VERSION);

    await expect(applyIOSNativeAppleConnection(prepared, harness.api)).rejects.toThrow(
      "changed after the approved preview",
    );
    expect(harness.patchCalls).toHaveLength(0);
    expect(harness.actualWrites()).toBe(0);
  });

  test("requires a valid server dry-run projection before the actual write", async () => {
    const harness = statefulAPI({ malformedDryRun: true });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    if (prepared.status !== "ready") throw new Error("expected ready plan");

    await expect(applyIOSNativeAppleConnection(prepared, harness.api)).rejects.toThrow(
      "could not safely validate native Sign in with Apple",
    );
    expect(harness.actualWrites()).toBe(0);
  });

  test("rejects a dry-run projection that drops existing Apple credential fields", async () => {
    const harness = statefulAPI({
      initial: connection(false, false, {
        client_id: SERVICES_ID,
        client_secret: PRIVATE_KEY,
        team_id: TEAM_ID,
        key_id: KEY_ID,
      }),
      replaceProjection: true,
    });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    if (prepared.status !== "ready") throw new Error("expected ready plan");

    await expect(applyIOSNativeAppleConnection(prepared, harness.api)).rejects.toThrow(
      "could not safely validate native Sign in with Apple",
    );
    expect(harness.patchCalls.map((call) => call.options.dryRun)).toEqual([true]);
    expect(harness.actualWrites()).toBe(0);
    expect(captured.err).not.toContain(PRIVATE_KEY);
  });

  test("rereads final state and rejects a write that did not persist", async () => {
    const harness = statefulAPI({ persistActual: false });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: harness.api,
      prompts: unexpectedPrompts(),
    });
    if (prepared.status !== "ready") throw new Error("expected ready plan");

    await expect(applyIOSNativeAppleConnection(prepared, harness.api)).rejects.toThrow(
      "did not pass final verification",
    );
    expect(harness.actualWrites()).toBe(1);
    expect(harness.current().enabled).toBe(false);
  });

  test("sanitizes read, dry-run, and write API failures", async () => {
    const readHarness = statefulAPI({ failFetch: new Error(API_SECRET) });
    let readError: unknown;
    try {
      await prepareIOSNativeAppleConnection(baseOptions(), {
        api: readHarness.api,
        prompts: unexpectedPrompts(),
      });
    } catch (error) {
      readError = error;
    }
    expect(String(readError)).not.toContain(API_SECRET);

    const dryRunHarness = statefulAPI({ failDryRun: new Error(PRIVATE_KEY) });
    const dryRunPrepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: dryRunHarness.api,
      prompts: unexpectedPrompts(),
    });
    if (dryRunPrepared.status !== "ready") throw new Error("expected ready plan");
    let dryRunError: unknown;
    try {
      await applyIOSNativeAppleConnection(dryRunPrepared, dryRunHarness.api);
    } catch (error) {
      dryRunError = error;
    }
    expect(String(dryRunError)).not.toContain(PRIVATE_KEY);

    const writeHarness = statefulAPI({ failActual: new Error(TEAM_ID) });
    const prepared = await prepareIOSNativeAppleConnection(baseOptions(), {
      api: writeHarness.api,
      prompts: unexpectedPrompts(),
    });
    if (prepared.status !== "ready") throw new Error("expected ready plan");
    let writeError: unknown;
    try {
      await applyIOSNativeAppleConnection(prepared, writeHarness.api);
    } catch (error) {
      writeError = error;
    }
    expect(String(writeError)).not.toContain(TEAM_ID);

    const allOutput = `${captured.err}\n${JSON.stringify({ readError, dryRunError, writeError })}`;
    for (const sensitive of [API_SECRET, PRIVATE_KEY, TEAM_ID, KEY_ID, SERVICES_ID]) {
      expect(allOutput).not.toContain(sensitive);
    }
  });

  test("accepts a missing config version but blocks malformed version material", () => {
    const withoutVersion = buildIOSNativeApplePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      nativeApplicationReady: true,
      config: { connection_oauth_apple: connection() },
      schema: appleSchema(),
    });
    expect(withoutVersion.status).toBe("ready");
    expect(withoutVersion.configVersion).toBeUndefined();

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
