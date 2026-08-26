import { describe, expect, test } from "bun:test";
import { ERROR_CODE, UserAbortError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import type { IOSNativeReadinessTarget } from "./native-readiness.ts";
import {
  applyIOSNativeRemoteSetup,
  buildIOSNativeRemotePlan,
  prepareIOSNativeRemoteSetup,
  validateAppIdPrefix,
  type IOSNativeRemoteAPI,
  type IOSNativeRemotePlan,
  type IOSNativeRemotePrompts,
} from "./native-remote.ts";
import type { IOSApplication, NativeSettings } from "../../../lib/plapi.ts";

const APPLICATION_ID = "app_native_test";
const INSTANCE_ID = "ins_native_development";
const BUNDLE_IDENTIFIER = "com.example.NativeApp";
const LOCAL_PREFIX = "LEGACY1234";
const EXPLICIT_PREFIX = "EXPLICIT12";

const captured = useCaptureLog();

function nativeSettings(apiEnabled: boolean): NativeSettings {
  return { object: "native_settings", api_enabled: apiEnabled };
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

function selectedTarget(
  options: {
    bundleIdentifier?: string;
    appIdPrefix?: string | null;
    appIdPrefixCandidates?: string[];
  } = {},
): IOSNativeReadinessTarget {
  const appIdPrefix = options.appIdPrefix === undefined ? LOCAL_PREFIX : options.appIdPrefix;
  return {
    status: "selected",
    projectPath: "NativeApp.xcodeproj",
    targetId: "TARGET_NATIVE_APP",
    targetName: "NativeApp",
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

function plan(options: {
  nativeApi: "required" | "satisfied";
  registration: "required" | "satisfied";
  appIdPrefix?: string;
}): IOSNativeRemotePlan {
  const appIdPrefix = options.appIdPrefix ?? LOCAL_PREFIX;
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-remote-setup",
    status:
      options.nativeApi === "satisfied" && options.registration === "satisfied"
        ? "satisfied"
        : "ready",
    applicationId: APPLICATION_ID,
    instanceId: INSTANCE_ID,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    appIdPrefix,
    nativeApi: options.nativeApi,
    registration: options.registration,
    actions: [
      ...(options.nativeApi === "required"
        ? ["Enable the Native API for the linked development instance."]
        : []),
      ...(options.registration === "required"
        ? [`Register iOS Bundle ID ${BUNDLE_IDENTIFIER} with Apple App ID Prefix ${appIdPrefix}.`]
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
} {
  const calls: string[] = [];
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
  test("validates the public App ID Prefix contract without assuming a Team ID shape", () => {
    expect(validateAppIdPrefix("  legacy.prefix-value  ")).toBe("legacy.prefix-value");
    expect(validateAppIdPrefix("   ")).toBeUndefined();
    expect(validateAppIdPrefix("x".repeat(256))).toBeUndefined();
  });

  test("revalidates a satisfied plan without prompting or writing", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(true)],
      registrationReads: [[exactRegistration]],
    });

    const result = await prepareIOSNativeRemoteSetup(prepareOptions({ yes: false }), {
      api,
      prompts: prompts(),
    });

    expect(result).toMatchObject({
      status: "satisfied",
      nativeApi: "satisfied",
      registration: "satisfied",
      bundleIdentifier: BUNDLE_IDENTIFIER,
      appIdPrefix: LOCAL_PREFIX,
      actions: [],
      blockers: [],
    });
    await applyIOSNativeRemoteSetup(result, api);
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

      await expect(applyIOSNativeRemoteSetup(approved, api)).rejects.toMatchObject({
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

    await applyIOSNativeRemoteSetup(plan({ nativeApi: "required", registration: "required" }), api);

    expect(calls).toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("blocks before writing when the pre-write re-read expands the approved action set", async () => {
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false)],
      registrationReads: [[]],
    });

    await expect(
      applyIOSNativeRemoteSetup(plan({ nativeApi: "satisfied", registration: "required" }), api),
    ).rejects.toThrow();

    expect(calls).not.toContain("POST iOS registration");
    expect(calls).not.toContain("PATCH native settings");
  });

  test("creates the iOS registration before enabling Native API", async () => {
    const exactRegistration = registration();
    const { api, calls } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[], [exactRegistration]],
    });

    await applyIOSNativeRemoteSetup(plan({ nativeApi: "required", registration: "required" }), api);

    expect(calls.indexOf("POST iOS registration")).toBeGreaterThan(-1);
    expect(calls.indexOf("POST iOS registration")).toBeLessThan(
      calls.indexOf("PATCH native settings"),
    );
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
      applyIOSNativeRemoteSetup(plan({ nativeApi: "satisfied", registration: "required" }), api),
    ).resolves.toBeUndefined();
    expect(calls.filter((call) => call === "POST iOS registration")).toHaveLength(1);
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
      applyIOSNativeRemoteSetup(plan({ nativeApi: "required", registration: "satisfied" }), api),
    ).resolves.toBeUndefined();
    expect(calls.filter((call) => call === "PATCH native settings")).toHaveLength(1);
  });

  test("fails final verification when the approved remote postcondition is not present", async () => {
    const { api } = scriptedAPI({
      nativeReads: [nativeSettings(false), nativeSettings(true)],
      registrationReads: [[], []],
    });

    await expect(
      applyIOSNativeRemoteSetup(plan({ nativeApi: "required", registration: "required" }), api),
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
    try {
      await applyIOSNativeRemoteSetup(
        plan({ nativeApi: "satisfied", registration: "required" }),
        api,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain(sensitiveBearer);
    expect(JSON.stringify(thrown)).not.toContain(sensitiveBearer);
    expect(captured.err).not.toContain(sensitiveBearer);
  });
});
