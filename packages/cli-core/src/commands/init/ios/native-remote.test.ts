import { describe, expect, test } from "bun:test";
import { ERROR_CODE, UserAbortError } from "../../../lib/errors.ts";
import { getLogLevel, setLogLevel } from "../../../lib/log.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import type { IOSNativeReadinessTarget } from "./native-readiness.ts";
import type { IOSNativePlatform } from "./types.ts";
import {
  applyIOSNativeRemoteSetup,
  auditIOSNativeRemoteSetup,
  buildIOSNativeRemotePlan,
  prepareIOSNativeRemoteSetup,
  validateAppIdPrefix,
  validateBundleIdentifier,
  type IOSNativeRemoteAPI,
  type IOSNativeRemotePlan,
  type IOSNativeRemotePrompts,
  type IOSNativeRemoteTargetReader,
  type IOSNativeRemoteTargetSnapshot,
  type IOSNativeRemoteReadAPI,
} from "./native-remote.ts";
import {
  validateNativeSettings,
  type IOSApplication,
  type NativeSettings,
} from "../../../lib/plapi.ts";
import {
  IOSNativeRegistrationRetryLockError,
  type IOSNativeRegistrationRetryIdentity,
  type IOSNativeRegistrationRetryStore,
} from "./native-registration-retry.ts";

const APPLICATION_ID = "app_native_test";
const INSTANCE_ID = "ins_native_development";
const BUNDLE_IDENTIFIER = "com.example.NativeApp";
const LOCAL_PREFIX = "LEGACY1234";
const EXPLICIT_PREFIX = "EXPLICIT12";
const IOS_ROOT = "/tmp/NativeApp";

const captured = useCaptureLog();

function nativeSettings(apiEnabled: boolean): NativeSettings {
  return { object: "native_settings", api_enabled: apiEnabled };
}

function malformedNativeSettings(apiEnabled: unknown): NativeSettings {
  return { object: "native_settings", api_enabled: apiEnabled } as unknown as NativeSettings;
}

function registration(
  appIdPrefix = LOCAL_PREFIX,
  bundleId = BUNDLE_IDENTIFIER,
  id = `iosapp_${appIdPrefix}`,
): IOSApplication {
  return {
    object: "ios_application",
    id,
    app_id_prefix: appIdPrefix,
    bundle_id: bundleId,
    created_at: 1_787_000_000_000,
    updated_at: 1_787_000_000_000,
  };
}

function malformedRegistration(): IOSApplication {
  return {
    object: "ios_application",
    id: "iosapp_malformed",
    app_id_prefix: LOCAL_PREFIX,
    created_at: 1_787_000_000_000,
    updated_at: 1_787_000_000_000,
  } as unknown as IOSApplication;
}

function selectedTarget(
  options: {
    bundleIdentifier?: string;
    appIdPrefix?: string | null;
    appIdPrefixCandidates?: string[];
    projectPath?: string;
    targetId?: string;
    platform?: IOSNativePlatform;
  } = {},
): IOSNativeReadinessTarget {
  const appIdPrefix = options.appIdPrefix === undefined ? LOCAL_PREFIX : options.appIdPrefix;
  return {
    status: "selected",
    projectPath: options.projectPath ?? "NativeApp.xcodeproj",
    targetId: options.targetId ?? "TARGET_NATIVE_APP",
    targetName: "NativeApp",
    platform: options.platform ?? "ios",
    bundleIdentifier: {
      status: "resolved",
      value: options.bundleIdentifier ?? BUNDLE_IDENTIFIER,
    },
    appIdPrefix:
      appIdPrefix == null
        ? {
            status: "missing",
            source: "literal-entitlements",
            ...(options.appIdPrefixCandidates ? { candidates: options.appIdPrefixCandidates } : {}),
          }
        : { status: "resolved", source: "literal-entitlements", value: appIdPrefix },
  };
}

function targetSnapshot(
  target: IOSNativeReadinessTarget = selectedTarget(),
): IOSNativeRemoteTargetSnapshot {
  if (target.status !== "selected") throw new Error("test target must be selected");
  return {
    root: IOS_ROOT,
    projectPath: target.projectPath,
    targetId: target.targetId,
    platform: target.platform,
    bundleIdentifier: target.bundleIdentifier,
    appIdPrefix: target.appIdPrefix,
  };
}

const approvedTargetReader: IOSNativeRemoteTargetReader = async (snapshot) => ({
  status: "selected",
  projectPath: snapshot.projectPath,
  targetId: snapshot.targetId,
  targetName: "NativeApp",
  platform: snapshot.platform,
  bundleIdentifier: snapshot.bundleIdentifier,
  appIdPrefix: snapshot.appIdPrefix,
});

function memoryRegistrationRetryStore(): {
  store: IOSNativeRegistrationRetryStore;
  pending(identity: IOSNativeRegistrationRetryIdentity): string | undefined;
} {
  const entries = new Map<string, string>();
  let issued = 0;
  const scope = (identity: IOSNativeRegistrationRetryIdentity) => JSON.stringify(identity);
  return {
    store: {
      async getOrCreate(identity) {
        const key = scope(identity);
        const existing = entries.get(key);
        if (existing) return existing;
        issued += 1;
        const created = `clerk-init-ios-registration-test-${issued}`;
        entries.set(key, created);
        return created;
      },
      async peek(identity) {
        return entries.get(scope(identity));
      },
      async clear(identity, expectedKey) {
        const key = scope(identity);
        const existing = entries.get(key);
        if (existing && existing !== expectedKey) return false;
        entries.delete(key);
        return true;
      },
    },
    pending(identity) {
      return entries.get(scope(identity));
    },
  };
}

function registrationRetryIdentity(
  overrides: Partial<IOSNativeRegistrationRetryIdentity> = {},
): IOSNativeRegistrationRetryIdentity {
  return {
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    appIdPrefix: LOCAL_PREFIX,
    ...overrides,
  };
}

async function applyRemoteSetup(
  approved: IOSNativeRemotePlan,
  api: IOSNativeRemoteAPI,
  targetReader: IOSNativeRemoteTargetReader = approvedTargetReader,
  registrationRetryStore: IOSNativeRegistrationRetryStore = memoryRegistrationRetryStore().store,
  revalidateLocalPreconditions?: () => Promise<void>,
): Promise<void> {
  await applyIOSNativeRemoteSetup(approved, {
    api,
    targetReader,
    registrationRetryStore,
    revalidateLocalPreconditions,
  });
}

function plan(options: {
  nativeApi: "required" | "satisfied";
  registration: "required" | "satisfied";
  appIdPrefix?: string;
  localAppIdPrefix?: string | null;
  platform?: IOSNativePlatform;
}): IOSNativeRemotePlan {
  const appIdPrefix = options.appIdPrefix ?? LOCAL_PREFIX;
  const localTarget = selectedTarget({
    appIdPrefix: options.localAppIdPrefix === undefined ? appIdPrefix : options.localAppIdPrefix,
    platform: options.platform,
  });
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-remote-setup",
    status:
      options.nativeApi === "satisfied" && options.registration === "satisfied"
        ? "satisfied"
        : "ready",
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    platform: options.platform ?? "ios",
    localTarget: targetSnapshot(localTarget),
    bundleIdentifier: BUNDLE_IDENTIFIER,
    appIdPrefix,
    nativeApi: options.nativeApi,
    registration: options.registration,
    actions: [
      ...(options.nativeApi === "required"
        ? ["Enable the Native API for the linked development instance."]
        : []),
      ...(options.registration === "required"
        ? [
            `Register ${options.platform === "macos" ? "macOS" : "iOS"} Bundle ID ${BUNDLE_IDENTIFIER} with Apple App ID Prefix ${appIdPrefix}.`,
          ]
        : []),
    ],
    blockers: [],
  };
}

interface ScriptedAPIOptions {
  nativeReads?: NativeSettings[];
  registrationReads?: IOSApplication[][];
  expectedAppIdPrefix?: string;
  enable?: IOSNativeRemoteAPI["enableNativeApi"];
  create?: IOSNativeRemoteAPI["createIOSApplication"];
}

function scriptedAPI(options: ScriptedAPIOptions = {}): {
  api: IOSNativeRemoteAPI;
  calls: string[];
  registrationIdempotencyKeys: string[];
} {
  const calls: string[] = [];
  const registrationIdempotencyKeys: string[] = [];
  const nativeReads = options.nativeReads ?? [nativeSettings(false)];
  const registrationReads = options.registrationReads ?? [[]];
  let nativeReadIndex = 0;
  let registrationReadIndex = 0;

  const nextNativeSettings = () =>
    nativeReads[Math.min(nativeReadIndex++, nativeReads.length - 1)]!;
  const nextRegistrations = () =>
    registrationReads[Math.min(registrationReadIndex++, registrationReads.length - 1)]!.map(
      (item) => ({ ...item }),
    );

  return {
    calls,
    registrationIdempotencyKeys,
    api: {
      async getNativeSettings(applicationId, instanceId) {
        expect(applicationId).toBe(APPLICATION_ID);
        expect(instanceId).toBe(INSTANCE_ID);
        calls.push("GET native settings");
        return nextNativeSettings();
      },
      async listIOSApplications(applicationId, instanceId) {
        expect(applicationId).toBe(APPLICATION_ID);
        expect(instanceId).toBe(INSTANCE_ID);
        calls.push("GET iOS registrations");
        return nextRegistrations();
      },
      async enableNativeApi(applicationId, instanceId, mutationOptions) {
        expect(applicationId).toBe(APPLICATION_ID);
        expect(instanceId).toBe(INSTANCE_ID);
        expect(mutationOptions.idempotencyKey).toStartWith("clerk-init-ios-native-api-");
        calls.push("PATCH native settings");
        if (options.enable) {
          return options.enable(applicationId, instanceId, mutationOptions);
        }
        return nativeSettings(true);
      },
      async createIOSApplication(applicationId, instanceId, params, mutationOptions) {
        expect(applicationId).toBe(APPLICATION_ID);
        expect(instanceId).toBe(INSTANCE_ID);
        expect(params).toEqual({
          appIdPrefix: options.expectedAppIdPrefix ?? LOCAL_PREFIX,
          bundleId: BUNDLE_IDENTIFIER,
        });
        expect(mutationOptions.idempotencyKey).toStartWith("clerk-init-ios-registration-");
        registrationIdempotencyKeys.push(mutationOptions.idempotencyKey);
        calls.push("POST iOS registration");
        if (options.create) {
          return options.create(applicationId, instanceId, params, mutationOptions);
        }
        return registration(params.appIdPrefix, params.bundleId);
      },
    },
  };
}

function prepareOptions(
  overrides: Partial<Parameters<typeof prepareIOSNativeRemoteSetup>[0]> = {},
): Parameters<typeof prepareIOSNativeRemoteSetup>[0] {
  return {
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    root: IOS_ROOT,
    target: selectedTarget(),
    agent: false,
    yes: true,
    ...overrides,
  };
}

function prompts(
  options: {
    appIdPrefix?: IOSNativeRemotePrompts["appIdPrefix"];
    confirmChanges?: () => Promise<boolean>;
  } = {},
): IOSNativeRemotePrompts {
  return {
    appIdPrefix:
      options.appIdPrefix ??
      (async () => {
        throw new Error("unexpected App ID Prefix prompt");
      }),
    confirmChanges:
      options.confirmChanges ??
      (async () => {
        throw new Error("unexpected remote-consent prompt");
      }),
  };
}

describe("Clerk Native Application remote setup", () => {
  test("audits through a GET-only API and returns the redacted remote plan", async () => {
    const calls: string[] = [];
    const sensitiveUnexpectedField = "pk_test_MUST_NOT_ESCAPE";
    const api: IOSNativeRemoteReadAPI = {
      async getNativeSettings(applicationId, instanceId) {
        expect([applicationId, instanceId]).toEqual([APPLICATION_ID, INSTANCE_ID]);
        calls.push("GET native settings");
        return {
          ...nativeSettings(true),
          publishable_key: sensitiveUnexpectedField,
        } as NativeSettings;
      },
      async listIOSApplications(applicationId, instanceId) {
        expect([applicationId, instanceId]).toEqual([APPLICATION_ID, INSTANCE_ID]);
        calls.push("GET iOS registrations");
        return [registration()];
      },
    };

    const result = await auditIOSNativeRemoteSetup(
      {
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        target: selectedTarget(),
      },
      api,
    );

    expect(result).toMatchObject({
      status: "satisfied",
      nativeApi: "satisfied",
      registration: "satisfied",
    });
    expect(calls.sort()).toEqual(["GET iOS registrations", "GET native settings"]);
    expect(JSON.stringify(result)).not.toContain(sensitiveUnexpectedField);
  });

  test("preserves GET transport errors for diagnostic classification", async () => {
    const transportError = new Error("native audit transport failure");
    const api: IOSNativeRemoteReadAPI = {
      async getNativeSettings() {
        throw transportError;
      },
      async listIOSApplications() {
        return [];
      },
    };

    await expect(
      auditIOSNativeRemoteSetup(
        {
          applicationId: APPLICATION_ID,
          instanceId: INSTANCE_ID,
          target: selectedTarget(),
        },
        api,
      ),
    ).rejects.toBe(transportError);
  });

  test("plans a macOS target through the existing Apple native application API", () => {
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      root: IOS_ROOT,
      target: selectedTarget({ platform: "macos" }),
      nativeSettings: nativeSettings(false),
      registrations: [],
    });

    expect(result).toMatchObject({
      status: "ready",
      platform: "macos",
      localTarget: { platform: "macos" },
      registration: "required",
      nativeApi: "required",
    });
    expect(result.actions).toContain(
      `Register macOS Bundle ID ${BUNDLE_IDENTIFIER} with Apple App ID Prefix ${LOCAL_PREFIX}.`,
    );
  });

  test("validates Apple identity formats without equating a prefix to the Team ID", () => {
    expect(validateAppIdPrefix("  LeGaCy1234  ")).toBe("LeGaCy1234");
    expect(validateAppIdPrefix("legacy.prefix-value")).toBeUndefined();
    expect(validateAppIdPrefix("   ")).toBeUndefined();
    expect(validateAppIdPrefix("x")).toBeUndefined();
    expect(validateAppIdPrefix("x".repeat(11))).toBeUndefined();
    expect(validateBundleIdentifier("NativeApp")).toBe("NativeApp");
    expect(validateBundleIdentifier("com.example-NativeApp")).toBe("com.example-NativeApp");
    expect(validateBundleIdentifier(".")).toBeUndefined();
    expect(validateBundleIdentifier(".com.example")).toBeUndefined();
    expect(validateBundleIdentifier("com..example")).toBeUndefined();
    expect(validateBundleIdentifier("com.example.")).toBeUndefined();
    expect(validateBundleIdentifier("com.example_bad")).toBeUndefined();
    expect(validateBundleIdentifier("x".repeat(256))).toBeUndefined();
  });

  test.each([".", ".com.example", "com..example", "com.example."])(
    "blocks the malformed Bundle ID %s before planning registration",
    (bundleIdentifier) => {
      const result = buildIOSNativeRemotePlan({
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        target: selectedTarget({ bundleIdentifier }),
        nativeSettings: nativeSettings(false),
        registrations: [],
      });

      expect(result.status).toBe("blocked");
      expect(result.registration).toBe("blocked");
      expect(result.actions).not.toContainEqual(expect.stringContaining("Register iOS Bundle ID"));
      expect(result.blockers).toContainEqual(
        expect.objectContaining({ code: "bundle-identifier-invalid" }),
      );
    },
  );

  test("accepts a legacy App ID Prefix that differs from DEVELOPMENT_TEAM", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[registration(LOCAL_PREFIX)]],
    });

    const result = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        unverifiedAppIdPrefixSuggestion: {
          source: "xcode-development-team",
          value: "ABCDE12345",
        },
      }),
      { api, prompts: prompts() },
    );

    expect(result).toMatchObject({
      status: "satisfied",
      appIdPrefix: LOCAL_PREFIX,
      registration: "satisfied",
      blockers: [],
    });
  });

  test("blocks the malformed Bundle ID and App ID Prefix reproduction together", () => {
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      target: selectedTarget({
        bundleIdentifier: "com.example_bad",
        appIdPrefix: "x",
      }),
      nativeSettings: nativeSettings(false),
      registrations: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bundle-identifier-invalid" }),
        expect.objectContaining({ code: "app-id-prefix-invalid" }),
      ]),
    );
  });

  test("rejects malformed Native settings before planning", () => {
    let thrown: unknown;
    try {
      buildIOSNativeRemotePlan({
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        target: selectedTarget(),
        nativeSettings: malformedNativeSettings("false"),
        registrations: [registration()],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("rejects malformed iOS registrations before planning", () => {
    let thrown: unknown;
    try {
      buildIOSNativeRemotePlan({
        applicationId: APPLICATION_ID,
        instanceId: INSTANCE_ID,
        target: selectedTarget(),
        nativeSettings: nativeSettings(true),
        registrations: [malformedRegistration()],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("rejects malformed registrations during the initial remote audit", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[malformedRegistration()]],
    });

    await expect(
      prepareIOSNativeRemoteSetup(prepareOptions(), { api, prompts: prompts() }),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls).not.toContain("POST iOS registration");
  });

  test.each([
    {
      name: "local Bundle ID",
      target: selectedTarget({ bundleIdentifier: "com.example_bad" }),
      requestedAppIdPrefix: undefined,
      registrations: [],
      blocker: "bundle-identifier-invalid",
    },
    {
      name: "local App ID Prefix",
      target: selectedTarget({ appIdPrefix: "x" }),
      requestedAppIdPrefix: undefined,
      registrations: [],
      blocker: "app-id-prefix-invalid",
    },
    {
      name: "partial local App ID Prefix candidate",
      target: selectedTarget({
        appIdPrefix: null,
        appIdPrefixCandidates: ["invalid-"],
      }),
      requestedAppIdPrefix: undefined,
      registrations: [],
      blocker: "app-id-prefix-invalid",
    },
    {
      name: "explicit App ID Prefix",
      target: selectedTarget({ appIdPrefix: null }),
      requestedAppIdPrefix: "x",
      registrations: [],
      blocker: "app-id-prefix-invalid",
    },
    {
      name: "existing registration App ID Prefix",
      target: selectedTarget({ appIdPrefix: null }),
      requestedAppIdPrefix: undefined,
      registrations: [registration("x")],
      blocker: "app-id-prefix-invalid",
    },
  ])("blocks an invalid $name before approval", (fixture) => {
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      target: fixture.target,
      requestedAppIdPrefix: fixture.requestedAppIdPrefix,
      nativeSettings: nativeSettings(false),
      registrations: [...fixture.registrations],
    });

    expect(result.status).toBe("blocked");
    expect(result.registration).toBe("blocked");
    expect(result.actions).not.toContainEqual(expect.stringContaining("Register iOS Bundle ID"));
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: fixture.blocker }));
  });

  test.each([
    {
      name: "invalid local identity",
      target: selectedTarget({ bundleIdentifier: "com.example_bad" }),
      registrations: [] as IOSApplication[],
    },
    {
      name: "invalid existing registration",
      target: selectedTarget({ appIdPrefix: null }),
      registrations: [registration("x")],
    },
  ])("does not request consent or write for an $name", async ({ target, registrations }) => {
    let consentCalls = 0;
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[...registrations]],
    });

    await expect(
      prepareIOSNativeRemoteSetup(prepareOptions({ target, yes: false }), {
        api,
        prompts: prompts({
          confirmChanges: async () => {
            consentCalls += 1;
            return true;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: ERROR_CODE.IOS_SETUP_BLOCKED });

    expect(consentCalls).toBe(0);
    expect(calls).toEqual(["GET native settings", "GET iOS registrations"]);
    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("revalidates a satisfied plan without prompting or writing", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[exactRegistration]],
    });
    let inspections = 0;

    const result = await prepareIOSNativeRemoteSetup(prepareOptions({ yes: false }), {
      api,
      prompts: prompts(),
    });

    expect(result).toMatchObject({
      status: "satisfied",
      nativeApi: "satisfied",
      registration: "satisfied",
      localTarget: {
        root: IOS_ROOT,
        projectPath: "NativeApp.xcodeproj",
        targetId: "TARGET_NATIVE_APP",
        bundleIdentifier: { status: "resolved", value: BUNDLE_IDENTIFIER },
        appIdPrefix: {
          status: "resolved",
          source: "literal-entitlements",
          value: LOCAL_PREFIX,
        },
      },
      bundleIdentifier: BUNDLE_IDENTIFIER,
      appIdPrefix: LOCAL_PREFIX,
      actions: [],
      blockers: [],
    });
    await applyRemoteSetup(result, api, async (snapshot) => {
      inspections += 1;
      return approvedTargetReader(snapshot);
    });
    expect(inspections).toBe(1);
    expect(calls).toEqual([
      "GET native settings",
      "GET iOS registrations",
      "GET native settings",
      "GET iOS registrations",
      "GET native settings",
      "GET iOS registrations",
    ]);
    expect(captured.err).toContain("already configured");
  });

  test.each([
    {
      name: "Bundle ID",
      current: selectedTarget({ bundleIdentifier: "com.example.Changed" }),
    },
    {
      name: "App ID Prefix",
      current: selectedTarget({ appIdPrefix: EXPLICIT_PREFIX }),
    },
  ])("fails a satisfied plan before remote access when its $name changes", async ({ current }) => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[registration()]],
    });
    let inspections = 0;
    const retryOperations: string[] = [];
    const retryStore: IOSNativeRegistrationRetryStore = {
      async getOrCreate() {
        retryOperations.push("getOrCreate");
        return "unexpected";
      },
      async peek() {
        retryOperations.push("peek");
        return undefined;
      },
      async clear() {
        retryOperations.push("clear");
        return true;
      },
    };

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "satisfied" }),
        api,
        async () => {
          inspections += 1;
          return current;
        },
        retryStore,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining("Xcode target identity changed"),
    });

    expect(inspections).toBe(1);
    expect(retryOperations).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("preserves recheck failure semantics for a satisfied plan", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[registration()]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "satisfied" }),
        api,
        async () => {
          throw new Error("xcconfig unreadable");
        },
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining("Xcode target identity could not be rechecked"),
    });

    expect(calls).toEqual([]);
  });

  test("rejects a macOS target that changes platform before remote access", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[registration()]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "satisfied", platform: "macos" }),
        api,
        async () => selectedTarget({ platform: "ios" }),
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining("Xcode target identity changed"),
    });

    expect(calls).toEqual([]);
  });

  test("registers a macOS target through the existing native application endpoint", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });

    await applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required", platform: "macos" }),
      api,
      approvedTargetReader,
    );

    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
    expect(captured.err).toContain(`macOS application ${BUNDLE_IDENTIFIER} registered with Clerk`);
  });

  test.each([
    {
      name: "Native API was disabled",
      nativeReads: [nativeSettings(true), nativeSettings(false)],
      registrationReads: [[registration()], [registration()]],
    },
    {
      name: "the exact iOS registration was deleted",
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[registration()], []],
    },
    {
      name: "the exact iOS registration prefix changed",
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[registration()], [registration(EXPLICIT_PREFIX)]],
    },
  ])(
    "fails closed without writing when $name after prepare",
    async ({ nativeReads, registrationReads }) => {
      const { api, calls } = scriptedAPI({
        nativeReads: [...nativeReads],
        registrationReads: registrationReads.map((items) => [...items]),
      });
      const approved = await prepareIOSNativeRemoteSetup(prepareOptions(), {
        api,
        prompts: prompts(),
      });

      await expect(applyRemoteSetup(approved, api)).rejects.toMatchObject({
        code: ERROR_CODE.IOS_SETUP_STALE,
        message:
          "Clerk Native Application settings changed after the approved preview. No remote changes were made; rerun clerk init to review the new plan.",
      });

      expect(calls).toEqual([
        "GET native settings",
        "GET iOS registrations",
        "GET native settings",
        "GET iOS registrations",
      ]);
      expect(calls).not.toContain("POST iOS registration");
      expect(calls).not.toContain("PATCH native settings");
    },
  );

  test("uses an explicit prefix when the registration is missing", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[]],
    });

    const result = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        appIdPrefix: EXPLICIT_PREFIX,
        agent: true,
      }),
      { api, prompts: prompts() },
    );

    expect(result).toMatchObject({
      status: "ready",
      nativeApi: "satisfied",
      registration: "required",
      bundleIdentifier: BUNDLE_IDENTIFIER,
      appIdPrefix: EXPLICIT_PREFIX,
      blockers: [],
    });
    expect(result.actions).toEqual([
      `Register iOS Bundle ID ${BUNDLE_IDENTIFIER} with Apple App ID Prefix ${EXPLICIT_PREFIX}.`,
    ]);
  });

  test("asks a human for a missing App ID Prefix before asking for remote consent", async () => {
    const promptOrder: string[] = [];
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const result = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({
          appIdPrefix: null,
          appIdPrefixCandidates: [LOCAL_PREFIX],
        }),
        unverifiedAppIdPrefixSuggestion: {
          source: "xcode-development-team",
          value: "ABCDE12345",
        },
        yes: false,
      }),
      {
        api,
        prompts: prompts({
          appIdPrefix: async (_bundleIdentifier, suggested) => {
            promptOrder.push("prefix");
            expect(suggested).toEqual({
              source: "partial-literal-entitlements",
              value: LOCAL_PREFIX,
            });
            return LOCAL_PREFIX;
          },
          confirmChanges: async () => {
            promptOrder.push("remote consent");
            return true;
          },
        }),
      },
    );

    expect(result.status).toBe("ready");
    expect(result.appIdPrefix).toBe(LOCAL_PREFIX);
    expect(promptOrder).toEqual(["prefix", "remote consent"]);
  });

  test("offers the unanimous Xcode Development Team but adopts only the human's choice", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const result = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        unverifiedAppIdPrefixSuggestion: {
          source: "xcode-development-team",
          value: "ABCDE12345",
        },
      }),
      {
        api,
        prompts: prompts({
          appIdPrefix: async (bundleIdentifier, suggested) => {
            expect(bundleIdentifier).toBe(BUNDLE_IDENTIFIER);
            expect(suggested).toEqual({
              source: "xcode-development-team",
              value: "ABCDE12345",
            });
            return EXPLICIT_PREFIX;
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "ready",
      appIdPrefix: EXPLICIT_PREFIX,
      registration: "required",
    });
  });

  test("offers an unverified Xcode suggestion in agent mode instead of prompting", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const error = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        unverifiedAppIdPrefixSuggestion: {
          source: "xcode-development-team",
          value: "ABCDE12345",
        },
        agent: true,
      }),
      { api, prompts: prompts() },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("ABCDE12345");
    expect(message).toContain("Xcode DEVELOPMENT_TEAM");
    expect(message).toContain("unverified suggestion");
    expect(message).toContain("Ask the user whether to use ABCDE12345 or enter a different");
    expect(message).toContain('--app-id-prefix "<confirmed_prefix>"');
  });

  test("offers partial literal entitlement evidence in agent mode", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const error = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({
          appIdPrefix: null,
          appIdPrefixCandidates: [LOCAL_PREFIX],
        }),
        agent: true,
      }),
      { api, prompts: prompts() },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(LOCAL_PREFIX);
    expect(message).toContain("literal App ID Prefix evidence");
    expect(message).toContain("unverified suggestion");
    expect(message).toContain(`Ask the user whether to use ${LOCAL_PREFIX} or enter a different`);
  });

  test("directs the agent to Apple Developer when no prefix suggestion exists", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const error = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        agent: true,
      }),
      { api, prompts: prompts() },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("requires --app-id-prefix");
    expect(message).toContain("copy the value labeled App ID Prefix in Apple Developer");
    expect(message).toContain('--app-id-prefix "<confirmed_prefix>"');
  });

  test("reports an application link that changed before a missing-prefix block", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    const error = await prepareIOSNativeRemoteSetup(
      prepareOptions({
        target: selectedTarget({ appIdPrefix: null }),
        applicationLinkChange: "link-updated",
        agent: true,
      }),
      { api, prompts: prompts() },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("The project's Clerk application link was updated");
    expect((error as Error).message).toContain(
      "no Xcode or Clerk Native Application settings changes were written",
    );
    expect((error as Error).message).not.toContain("No local or remote setup changes were written");
  });

  test("blocks an explicit prefix that conflicts with a partial local candidate", () => {
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      target: selectedTarget({
        appIdPrefix: null,
        appIdPrefixCandidates: [LOCAL_PREFIX],
      }),
      requestedAppIdPrefix: EXPLICIT_PREFIX,
      nativeSettings: nativeSettings(false),
      registrations: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "app-id-prefix-conflict" }),
    );
  });

  test("adopts the sole existing registration prefix when local evidence is absent", () => {
    const existing = registration(EXPLICIT_PREFIX);
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      target: selectedTarget({ appIdPrefix: null }),
      nativeSettings: nativeSettings(false),
      registrations: [existing],
    });

    expect(result).toMatchObject({
      status: "ready",
      appIdPrefix: EXPLICIT_PREFIX,
      nativeApi: "required",
      registration: "satisfied",
      blockers: [],
    });
  });

  test("matches Bundle IDs case-insensitively and preserves the registration's stored spelling", () => {
    const storedBundleIdentifier = "com.example.nativeapp";
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      root: IOS_ROOT,
      target: selectedTarget(),
      nativeSettings: nativeSettings(true),
      registrations: [registration(LOCAL_PREFIX, storedBundleIdentifier)],
    });

    expect(result).toMatchObject({
      status: "satisfied",
      bundleIdentifier: storedBundleIdentifier,
      registration: "satisfied",
      blockers: [],
    });
    expect(result.localTarget).toMatchObject({
      bundleIdentifier: { status: "resolved", value: BUNDLE_IDENTIFIER },
    });
  });

  test("keeps a case-only rerun read-only", async () => {
    const storedBundleIdentifier = "com.example.nativeapp";
    const approved = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      root: IOS_ROOT,
      target: selectedTarget(),
      nativeSettings: nativeSettings(true),
      registrations: [registration(LOCAL_PREFIX, storedBundleIdentifier)],
    });
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [
        [registration(LOCAL_PREFIX, storedBundleIdentifier)],
        [registration(LOCAL_PREFIX, storedBundleIdentifier)],
      ],
    });

    await applyRemoteSetup(approved, api, approvedTargetReader);

    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test.each([
    {
      name: "duplicate prefixes for one Bundle ID",
      target: selectedTarget({ appIdPrefix: null }),
      registrations: [registration(LOCAL_PREFIX), registration(EXPLICIT_PREFIX)],
      blocker: "duplicate-bundle-registration",
    },
    {
      name: "an existing prefix that conflicts with the selected prefix",
      target: selectedTarget(),
      registrations: [registration(EXPLICIT_PREFIX)],
      blocker: "app-id-prefix-conflict",
    },
  ])("blocks $name", ({ target, registrations, blocker }) => {
    const result = buildIOSNativeRemotePlan({
      applicationId: APPLICATION_ID,
      instanceId: INSTANCE_ID,
      target,
      nativeSettings: nativeSettings(false),
      registrations: [...registrations],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: blocker }));
  });

  test("requires separate consent for the remote mutations", async () => {
    let consentCalls = 0;
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    await expect(
      prepareIOSNativeRemoteSetup(prepareOptions({ yes: false }), {
        api,
        prompts: prompts({
          confirmChanges: async () => {
            consentCalls += 1;
            return false;
          },
        }),
      }),
    ).rejects.toBeInstanceOf(UserAbortError);

    expect(consentCalls).toBe(1);
    expect(calls).toEqual(["GET native settings", "GET iOS registrations"]);
    expect(captured.err).toContain("remote Clerk changes");
  });

  test("re-reads before writing and permits the approved action set to shrink", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      // Native API was enabled by another actor after consent.
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });

    await applyRemoteSetup(
      plan({ nativeApi: "required", registration: "required" }),
      api,
      approvedTargetReader,
    );

    expect(calls).toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("blocks before writing when the pre-write re-read expands the approved action set", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toThrow();

    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test.each([
    {
      name: "the Bundle ID changes",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      current: selectedTarget({ bundleIdentifier: "com.example.Changed" }),
    },
    {
      name: "the proven App ID Prefix changes",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      current: selectedTarget({ appIdPrefix: EXPLICIT_PREFIX }),
    },
    {
      name: "the proven App ID Prefix disappears",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      current: selectedTarget({ appIdPrefix: null }),
    },
    {
      name: "the target changes",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      current: selectedTarget({ targetId: "TARGET_CHANGED" }),
    },
    {
      name: "the project changes",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      current: selectedTarget({ projectPath: "Changed.xcodeproj" }),
    },
    {
      name: "new evidence conflicts with a user-confirmed prefix",
      approved: plan({
        nativeApi: "satisfied",
        registration: "required",
        appIdPrefix: EXPLICIT_PREFIX,
        localAppIdPrefix: null,
      }),
      current: selectedTarget({ appIdPrefix: LOCAL_PREFIX }),
    },
  ])("fails closed before mutation when $name", async ({ approved, current }) => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[]],
      expectedAppIdPrefix: approved.appIdPrefix,
    });

    await expect(applyRemoteSetup(approved, api, async () => current)).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining("Xcode target identity changed"),
    });

    expect(calls).toEqual([]);
    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("fails closed before mutation when the Xcode identity cannot be inspected", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        async () => {
          throw new Error("xcconfig unreadable");
        },
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining("Xcode target identity could not be rechecked"),
    });

    expect(calls).toEqual([]);
    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("revalidates identity before a Native API-only mutation", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[registration()]],
    });

    await expect(
      applyRemoteSetup(plan({ nativeApi: "required", registration: "satisfied" }), api, async () =>
        selectedTarget({ bundleIdentifier: "com.example.Changed" }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODE.IOS_SETUP_STALE });

    expect(calls).toEqual([]);
    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test.each([
    {
      name: "registration",
      approved: plan({ nativeApi: "satisfied", registration: "required" }),
      nativeReads: [nativeSettings(true)] as NativeSettings[],
      registrationReads: [[]] as IOSApplication[][],
    },
    {
      name: "Native API",
      approved: plan({ nativeApi: "required", registration: "satisfied" }),
      nativeReads: [nativeSettings(false)] as NativeSettings[],
      registrationReads: [[registration()]] as IOSApplication[][],
    },
  ])(
    "revalidates caller-owned local state at the $name mutation boundary",
    async ({ approved, nativeReads, registrationReads }) => {
      const { api, calls } = scriptedAPI({ nativeReads, registrationReads });
      const retry = memoryRegistrationRetryStore();
      let revalidations = 0;

      await expect(
        applyRemoteSetup(approved, api, approvedTargetReader, retry.store, async () => {
          revalidations += 1;
          throw new Error("secondary platform identity changed");
        }),
      ).rejects.toThrow("secondary platform identity changed");

      expect(revalidations).toBe(1);
      expect(calls).toEqual(["GET native settings", "GET iOS registrations"]);
      expect(calls).not.toContain("POST iOS registration");
      expect(calls).not.toContain("PATCH native settings");
    },
  );

  test("revalidates caller-owned local state before accepting a remote no-op", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[registration()], [registration()]],
    });
    let revalidations = 0;

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "satisfied" }),
        api,
        approvedTargetReader,
        memoryRegistrationRetryStore().store,
        async () => {
          revalidations += 1;
          throw new Error("secondary platform identity changed");
        },
      ),
    ).rejects.toThrow("secondary platform identity changed");

    expect(revalidations).toBe(1);
    expect(calls).toEqual([
      "GET native settings",
      "GET iOS registrations",
      "GET native settings",
      "GET iOS registrations",
    ]);
    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("accepts unchanged identity and newly proven evidence matching a confirmed prefix", async () => {
    const exactRegistration = registration(EXPLICIT_PREFIX);
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
      expectedAppIdPrefix: EXPLICIT_PREFIX,
    });
    let inspections = 0;
    const approved = plan({
      nativeApi: "satisfied",
      registration: "required",
      appIdPrefix: EXPLICIT_PREFIX,
      localAppIdPrefix: null,
    });

    await applyRemoteSetup(approved, api, async () => {
      inspections += 1;
      return selectedTarget({ appIdPrefix: EXPLICIT_PREFIX });
    });

    expect(inspections).toBe(1);
    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
    expect(calls).not.toContain("PATCH native settings");
  });

  test("rejects malformed registrations before the pre-write registration decision", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[malformedRegistration()]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls).not.toContain("POST iOS registration");
  });

  test("creates the iOS registration before enabling Native API", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });

    await applyRemoteSetup(
      plan({ nativeApi: "required", registration: "required" }),
      api,
      approvedTargetReader,
    );

    expect(calls.indexOf("POST iOS registration")).toBeGreaterThan(-1);
    expect(calls.indexOf("POST iOS registration")).toBeLessThan(
      calls.indexOf("PATCH native settings"),
    );
  });

  test("surfaces safe manual recovery for a stale retry lock before remote access", async () => {
    const recoveryPath = "$CLERK_CONFIG_DIR/idempotency/ios-native-registration-test.json.lock";
    const retryStore: IOSNativeRegistrationRetryStore = {
      async getOrCreate() {
        throw new IOSNativeRegistrationRetryLockError("stale", recoveryPath);
      },
      async peek() {
        throw new Error("unexpected peek");
      },
      async clear() {
        throw new Error("unexpected clear");
      },
    };
    const { api, calls } = scriptedAPI();

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
        retryStore,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_APPLY_FAILED,
      message: expect.stringContaining(
        `Confirm no other Clerk command is running, then remove only the stale lock directory at \`${recoveryPath}\``,
      ),
    });
    expect(calls).toEqual([]);
  });

  test("reconciles an ambiguous registration-create error when the exact row now exists", async () => {
    const exactRegistration = registration();
    const ambiguousError = new Error("connection reset after create");
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration], [exactRegistration]],
      create: async () => {
        throw ambiguousError;
      },
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).resolves.toBeUndefined();
    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
  });

  test("does not let a fallback list hide a malformed registration create response", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
      create: async () => malformedRegistration(),
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls.filter((call) => call === "GET iOS registrations")).toHaveLength(1);
    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
  });

  test("rejects malformed registrations while confirming an ambiguous create", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[], [malformedRegistration()]],
      create: async () => {
        throw new Error("connection reset after create");
      },
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
  });

  test("rejects malformed registrations during final verification", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [malformedRegistration()]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
  });

  test("reuses a pending registration key across invocations until final verification", async () => {
    const retry = memoryRegistrationRetryStore();
    const ambiguous = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[], []],
      create: async () => {
        throw new Error("connection reset after unknown outcome");
      },
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        ambiguous.api,
        approvedTargetReader,
        retry.store,
      ),
    ).rejects.toThrow("could not be registered");
    const firstKey = ambiguous.registrationIdempotencyKeys[0]!;
    expect(retry.pending(registrationRetryIdentity())).toBe(firstKey);

    const exactRegistration = registration();
    const retried = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });
    await applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required" }),
      retried.api,
      approvedTargetReader,
      retry.store,
    );

    expect(retried.registrationIdempotencyKeys).toEqual([firstKey]);
    expect(retry.pending(registrationRetryIdentity())).toBeUndefined();

    const recreated = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });
    await applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required" }),
      recreated.api,
      approvedTargetReader,
      retry.store,
    );
    expect(recreated.registrationIdempotencyKeys[0]).not.toBe(firstKey);
  });

  test("clears a pending retry when a rerun verifies that registration already exists", async () => {
    const retry = memoryRegistrationRetryStore();
    const pendingKey = await retry.store.getOrCreate(registrationRetryIdentity());
    const exactRegistration = registration();
    const { api, calls, registrationIdempotencyKeys } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[exactRegistration], [exactRegistration]],
    });

    await applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required" }),
      api,
      approvedTargetReader,
      retry.store,
    );

    expect(pendingKey).toStartWith("clerk-init-ios-registration-");
    expect(registrationIdempotencyKeys).toEqual([]);
    expect(calls).not.toContain("POST iOS registration");
    expect(retry.pending(registrationRetryIdentity())).toBeUndefined();
  });

  test("surfaces stale-lock recovery when verified remote state cannot clear retry state", async () => {
    const recoveryPath = "~/.config/clerk-cli/idempotency/ios-native-registration-test.json.lock";
    const retryKey = "clerk-init-ios-registration-11111111-1111-4111-8111-111111111111";
    const retryStore: IOSNativeRegistrationRetryStore = {
      async getOrCreate() {
        return retryKey;
      },
      async peek() {
        return retryKey;
      },
      async clear() {
        throw new IOSNativeRegistrationRetryLockError("stale", recoveryPath);
      },
    };
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
        approvedTargetReader,
        retryStore,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining(
        `no further remote changes are required. Confirm no other Clerk command is running, then remove only the stale lock directory at \`${recoveryPath}\``,
      ),
    });
    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
  });

  test("rechecks remote state after a paused invocation acquires a newer retry generation", async () => {
    const retry = memoryRegistrationRetryStore();
    let releaseGet!: () => void;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let reportPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      reportPaused = resolve;
    });
    const pausedStore: IOSNativeRegistrationRetryStore = {
      async getOrCreate(identity) {
        reportPaused();
        await getGate;
        return retry.store.getOrCreate(identity);
      },
      async peek(identity) {
        return retry.store.peek(identity);
      },
      async clear(identity, expectedKey) {
        return retry.store.clear(identity, expectedKey);
      },
    };
    const exactRegistration = registration();
    const resumed = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[exactRegistration], [exactRegistration]],
    });

    const resumedApply = applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required" }),
      resumed.api,
      approvedTargetReader,
      pausedStore,
    );
    await paused;

    const first = scriptedAPI({
      nativeReads: [nativeSettings(true), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });
    await applyRemoteSetup(
      plan({ nativeApi: "satisfied", registration: "required" }),
      first.api,
      approvedTargetReader,
      retry.store,
    );
    const completedKey = first.registrationIdempotencyKeys[0]!;
    expect(retry.pending(registrationRetryIdentity())).toBeUndefined();

    releaseGet();
    await resumedApply;

    expect(resumed.registrationIdempotencyKeys).toEqual([]);
    expect(resumed.calls).not.toContain("POST iOS registration");
    expect(retry.pending(registrationRetryIdentity())).toBeUndefined();
    expect(completedKey).toStartWith("clerk-init-ios-registration-");
  });

  test("reconciles an ambiguous Native API error when a re-read shows it enabled", async () => {
    const exactRegistration = registration();
    const ambiguousError = new Error("connection reset after enable");
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true), nativeSettings(true)],
      registrationReads: [[exactRegistration], [exactRegistration]],
      enable: async () => {
        throw ambiguousError;
      },
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "satisfied" }),
        api,
        approvedTargetReader,
      ),
    ).resolves.toBeUndefined();
    expect(calls.filter((call) => call === "PATCH native settings")).toHaveLength(1);
  });

  test("does not let a follow-up GET hide a malformed Native settings PATCH response", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[exactRegistration]],
      enable: async () => malformedNativeSettings("false"),
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "satisfied" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls.filter((call) => call === "GET native settings")).toHaveLength(1);
    expect(calls.filter((call) => call === "PATCH native settings")).toHaveLength(1);
  });

  test("does not let a follow-up GET hide a Native settings client parser failure", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[exactRegistration]],
      enable: async () => validateNativeSettings(malformedNativeSettings("false")),
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "satisfied" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });

    expect(calls.filter((call) => call === "GET native settings")).toHaveLength(1);
    expect(calls.filter((call) => call === "PATCH native settings")).toHaveLength(1);
  });

  test("rejects malformed Native settings returned by ambiguity confirmation", async () => {
    const exactRegistration = registration();
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false), malformedNativeSettings("false")],
      registrationReads: [[exactRegistration]],
      enable: async () => {
        throw new Error("connection reset after enable");
      },
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "satisfied" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("rejects malformed Native settings during final verification", async () => {
    const exactRegistration = registration();
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false), malformedNativeSettings("false")],
      registrationReads: [[exactRegistration], [exactRegistration]],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "satisfied" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
    });
  });

  test("fails final verification when the approved remote postcondition is not present", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[], []],
    });

    await expect(
      applyRemoteSetup(
        plan({ nativeApi: "required", registration: "required" }),
        api,
        approvedTargetReader,
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      message: expect.stringContaining("did not pass the final verification"),
    });
  });

  test("does not expose credential or publishable-key material in plans, output, or errors", async () => {
    const sensitivePublishableKey = "pk_test_PUBLISHABLE_KEY_MUST_NOT_ESCAPE";
    const sensitiveBearer = "Bearer ak_API_TOKEN_MUST_NOT_ESCAPE";
    const settingsWithUnexpectedSecret = {
      ...nativeSettings(false),
      publishable_key: sensitivePublishableKey,
    } as NativeSettings;
    const { api: prepareAPI } = scriptedAPI({
      nativeReads: [settingsWithUnexpectedSecret],
      registrationReads: [[]],
    });

    const prepared = await prepareIOSNativeRemoteSetup(prepareOptions(), {
      api: prepareAPI,
      prompts: prompts(),
    });
    expect(JSON.stringify(prepared)).not.toContain(sensitivePublishableKey);
    expect(captured.err).not.toContain(sensitivePublishableKey);

    captured.clear();
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[], []],
      create: async () => {
        throw new Error(`request failed with ${sensitiveBearer}`);
      },
    });

    let thrown: unknown;
    const previousLogLevel = getLogLevel();
    try {
      setLogLevel("debug");
      try {
        await applyRemoteSetup(
          plan({ nativeApi: "satisfied", registration: "required" }),
          api,
          approvedTargetReader,
        );
      } catch (error) {
        thrown = error;
      }
    } finally {
      setLogLevel(previousLogLevel);
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain(sensitiveBearer);
    expect(JSON.stringify(thrown)).not.toContain(sensitiveBearer);
    expect(captured.err).toContain(
      "Could not create the Apple native application registration; underlying error details were omitted.",
    );
    expect(captured.err).not.toContain(sensitiveBearer);
  });
});
