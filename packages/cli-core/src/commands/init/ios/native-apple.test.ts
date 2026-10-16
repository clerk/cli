import { describe, expect, test } from "bun:test";
import { ERROR_CODE } from "../../../lib/errors.ts";
import type { InstanceConfigSchema } from "../../../lib/plapi.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  applyIOSNativeAppleConnection,
  auditIOSNativeAppleHealth,
  auditIOSNativeAppleConnection,
  type IOSNativeAppleAPI,
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

useCaptureLog();

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

const target = {
  applicationId: APPLICATION_ID,
  instanceId: INSTANCE_ID,
  bundleIdentifier: BUNDLE_IDENTIFIER,
};

type PatchCall = {
  config: Record<string, unknown>;
  options: { dryRun: boolean; ifMatch: string };
};

function statefulAPI(
  options: {
    initial?: AppleConnection;
    schema?: InstanceConfigSchema;
    version?: string | null;
    failFetch?: unknown;
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

const webCredentials = {
  client_id: SERVICES_ID,
  client_secret: PRIVATE_KEY,
  team_id: TEAM_ID,
  key_id: KEY_ID,
};

describe("native Sign in with Apple", () => {
  test("health is credential-free and reads only the Apple connection", async () => {
    const { api, calls } = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER, ...webCredentials }),
    });

    const result = await auditIOSNativeAppleHealth(target, api);

    expect(result.runtime).toEqual({
      status: "satisfied",
      bundleIdentifierConfiguration: "satisfied",
      current: { enabled: true, authenticatable: true },
      blockers: [],
    });
    expect(calls).toEqual(["GET config"]);
    for (const secret of Object.values(webCredentials))
      expect(JSON.stringify(result)).not.toContain(secret);
  });

  test.each([
    {
      name: "a disabled connection",
      value: connection(false),
      status: "required",
      blocker: undefined,
    },
    {
      name: "a case-only Bundle ID difference",
      value: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER.toLowerCase() }),
      status: "required",
      blocker: undefined,
    },
    {
      name: "another app's Bundle ID",
      value: connection(true, true, { bundle_id: "com.example.Other" }),
      status: "blocked",
      blocker: "apple-bundle-identifier-conflict",
    },
    {
      name: "an enabled connection that cannot authenticate",
      value: connection(true, false),
      status: "blocked",
      blocker: "apple-authenticatable-conflict",
    },
  ])("health reports $status for $name", async ({ value, status, blocker }) => {
    const { api } = statefulAPI({ initial: value });
    const { runtime } = await auditIOSNativeAppleHealth(target, api);
    expect(runtime.status).toBe(status);
    expect(runtime.blockers.map((item) => item.code)).toEqual(blocker ? [blocker] : []);
  });

  test("a needed repair requires the patch schema and a config version", async () => {
    expect(
      (await auditIOSNativeAppleConnection(target, statefulAPI({ schema: {} }).api)).blockers,
    ).toEqual([expect.objectContaining({ code: "apple-config-unsupported" })]);
    expect(
      (await auditIOSNativeAppleConnection(target, statefulAPI({ version: null }).api)).blockers,
    ).toEqual([expect.objectContaining({ code: "apple-config-version-unavailable" })]);
  });

  test("an already-correct connection is satisfied without a version or patch schema", async () => {
    const { api } = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
      schema: {},
      version: null,
    });
    expect((await auditIOSNativeAppleConnection(target, api)).status).toBe("satisfied");
  });

  test("apply dry-runs, revalidates locally, then writes only native fields with If-Match", async () => {
    const state = statefulAPI({ initial: connection(false, true, webCredentials) });
    const plan = await auditIOSNativeAppleConnection(target, state.api);
    expect(plan).toMatchObject({ status: "ready", configVersion: CONFIG_VERSION });

    await applyIOSNativeAppleConnection(plan, {
      api: state.api,
      revalidateLocalPreconditions: async () => {
        state.calls.push("revalidate local");
      },
    });

    expect(state.calls).toEqual([
      "GET config",
      "GET schema",
      "PATCH dry-run",
      "revalidate local",
      "PATCH apply",
      "GET config",
      "GET schema",
    ]);
    for (const call of state.patchCalls) {
      expect(call.config).toEqual({
        connection_oauth_apple: {
          enabled: true,
          authenticatable: true,
          bundle_id: BUNDLE_IDENTIFIER,
        },
      });
      expect(call.options.ifMatch).toBe(CONFIG_VERSION);
    }
    expect(state.current()).toEqual({
      ...connection(true, true, webCredentials),
      bundle_id: BUNDLE_IDENTIFIER,
    });
  });

  test("a merge that would drop web credentials stops before writing", async () => {
    const state = statefulAPI({
      initial: connection(false, true, webCredentials),
      replaceProjection: true,
    });
    const plan = await auditIOSNativeAppleConnection(target, state.api);

    await expect(applyIOSNativeAppleConnection(plan, { api: state.api })).rejects.toMatchObject({
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
    expect(state.actualWrites()).toBe(0);
  });

  test("a stale config version writes nothing", async () => {
    const state = statefulAPI();
    const plan = await auditIOSNativeAppleConnection(target, state.api);
    state.setVersion(NEXT_CONFIG_VERSION);

    await expect(applyIOSNativeAppleConnection(plan, { api: state.api })).rejects.toThrow(
      "config version conflict",
    );
    expect(state.actualWrites()).toBe(0);
  });

  test("a write that did not persist fails final verification", async () => {
    const state = statefulAPI({ persistActual: false });
    const plan = await auditIOSNativeAppleConnection(target, state.api);

    await expect(applyIOSNativeAppleConnection(plan, { api: state.api })).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    });
  });

  test("a satisfied plan only revalidates local state", async () => {
    const state = statefulAPI({
      initial: connection(true, true, { bundle_id: BUNDLE_IDENTIFIER }),
    });
    const plan = await auditIOSNativeAppleConnection(target, state.api);
    let revalidated = false;

    await applyIOSNativeAppleConnection(plan, {
      api: state.api,
      revalidateLocalPreconditions: async () => {
        revalidated = true;
      },
    });
    expect(revalidated).toBe(true);
    expect(state.patchCalls).toEqual([]);
  });

  test("a blocked plan is never applied", async () => {
    const state = statefulAPI({ initial: connection(true, false) });
    const plan = await auditIOSNativeAppleConnection(target, state.api);
    await expect(applyIOSNativeAppleConnection(plan, { api: state.api })).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    });
    expect(state.patchCalls).toEqual([]);
  });
});
