import { test, expect, describe, spyOn } from "bun:test";

// Pure spyOn approach — Bun's mock.module globally replaces modules for the
// entire test run, which pollutes other test files that import the same
// modules. spyOn restores cleanly. Shared setup lives in the harness.
import {
  useInitHarness,
  FAKE_CTX,
  loginMod,
  linkMod,
  pullMod,
  config,
  frameworkMod,
  context,
  scaffoldMod,
  heuristics,
  skillsMod,
  bootstrapMod,
  iosApplyMod,
  nativeRemoteMod,
  nativeAppleMod,
  iosDevelopmentKeyMod,
  iosPlatformViewsMod,
  plapiMod,
  fapiMod,
  FAKE_IOS_NATIVE_READINESS,
  FAKE_IOS_PLATFORM_VIEWS,
} from "../../test/lib/init-harness.ts";
import * as telemetryMod from "../../lib/telemetry.ts";
import { getLogLevel, setLogLevel } from "../../lib/log.ts";
import * as iosFileTransactionMod from "./ios/file-transaction.ts";
import { init } from "./index.ts";
import { ERROR_CODE, PlapiError } from "../../lib/errors.ts";
import type { IOSLocalSetupResult } from "./ios/apply.ts";
import type { IOSAppleEntitlementPlan } from "./ios/apple-entitlement.ts";
import type { IOSNativeApplePlan } from "./ios/native-apple.ts";
import type { IOSNativeRemotePlan } from "./ios/native-remote.ts";
import type { IOSNativeReadinessTarget } from "./ios/native-readiness.ts";
import type { IOSPrebuiltAuthPlan } from "./ios/prebuilt-auth.ts";

const VALID_DEVELOPMENT_KEY = `pk_test_${btoa("example.clerk.accounts.dev$")}`;

function nativeIOSContext() {
  return {
    ...FAKE_CTX,
    deps: {},
    envFile: ".env",
    framework: {
      dep: "ios",
      name: "iOS (Swift)",
      sdk: "ClerkKit",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "swift" as const,
    },
  };
}

function iosRemotePlan(overrides: Partial<IOSNativeRemotePlan> = {}): IOSNativeRemotePlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-remote-setup",
    status: "ready",
    applicationId: "app_test",
    instanceId: "ins_test",
    platform: "ios",
    bundleIdentifier: "com.example.MyApp",
    appIdPrefix: "LEGACY1234",
    nativeApi: "required",
    registration: "required",
    actions: ["Register the iOS application.", "Enable the Native API."],
    blockers: [],
    ...overrides,
  };
}

function iosAppleEntitlementPlan(
  overrides: Partial<IOSAppleEntitlementPlan> = {},
): IOSAppleEntitlementPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-sign-in-with-apple-entitlement",
    status: "ready",
    root: "/tmp/test",
    projectPath: "MyApp.xcodeproj",
    targetId: "TARGET",
    targetName: "MyApp",
    files: [
      {
        path: "MyApp/MyApp.entitlements",
        operation: "modify",
        expectedHash: "hash",
      },
    ],
    actions: ["Add the native Sign in with Apple entitlement."],
    blockers: [],
    ...overrides,
  };
}

function iosNativeApplePlan(overrides: Partial<IOSNativeApplePlan> = {}): IOSNativeApplePlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-apple-connection",
    status: "ready",
    applicationId: "app_test",
    instanceId: "ins_test",
    bundleIdentifier: "com.example.MyApp",
    configVersion: "v1_1234abcd",
    connection: "required",
    bundleIdentifierConfiguration: "required",
    current: { enabled: false, authenticatable: false },
    desired: { enabled: true, authenticatable: true },
    actions: ["Enable native Sign in with Apple for com.example.MyApp."],
    blockers: [],
    ...overrides,
  };
}

function iosPrebuiltAuthPlan(overrides: Partial<IOSPrebuiltAuthPlan> = {}): IOSPrebuiltAuthPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-prebuilt-auth",
    status: "ready",
    root: "/tmp/test",
    projectPath: "MyApp.xcodeproj",
    targetId: "TARGET",
    platform: "ios",
    allowDirty: false,
    appSourcePath: "MyApp/MyAppApp.swift",
    expectedAppSourceHash: "app-hash",
    sourcePath: "MyApp/ContentView.swift",
    expectedSourceHash: "content-hash",
    actions: [],
    blockers: [],
    ...overrides,
  };
}

function iosSetupResult(overrides: Partial<IOSLocalSetupResult> = {}): IOSLocalSetupResult {
  return {
    targetName: "MyApp",
    platform: "ios",
    supportedPlatforms: ["ios"],
    platformViews: FAKE_IOS_PLATFORM_VIEWS,
    setupPlan: {
      schemaVersion: 1,
      kind: "clerk-ios-setup",
      root: "/tmp/test",
      status: "ready",
      selection: {
        state: "selected",
        targetId: "TARGET",
        targetName: "MyApp",
        projectPath: "MyApp.xcodeproj",
        platform: "ios",
      },
      summary: { satisfied: 0, required: 0, review: 0, blocked: 0 },
      steps: [],
      diagnostics: [],
    },
    nativeReadiness: FAKE_IOS_NATIVE_READINESS,
    prebuiltAuthRequested: false,
    prebuiltAuthActive: false,
    nativeAppleRequested: false,
    requiresLinkedApp: false,
    requiresDevelopmentKey:
      overrides.requiresDevelopmentKey ?? overrides.requiresLinkedApp ?? false,
    requiresExplicitApplication: false,
    ...overrides,
  };
}

function selectedNativeTarget(
  overrides: Partial<Extract<IOSNativeReadinessTarget, { status: "selected" }>> = {},
): Extract<IOSNativeReadinessTarget, { status: "selected" }> {
  const target = FAKE_IOS_NATIVE_READINESS.target;
  if (target.status !== "selected") throw new Error("Expected a selected iOS test target");
  return { ...target, ...overrides };
}

describe("init iOS", () => {
  const { setup, track } = useInitHarness();

  function trackStages() {
    const stage = spyOn(telemetryMod, "setTelemetryStage");
    track(stage);
    return () => stage.mock.calls.map((call) => call[0]);
  }

  test("labels the selected macOS target before final scaffolding", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const ctx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(ctx);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        platform: "macos",
        nativeReadiness: {
          ...FAKE_IOS_NATIVE_READINESS,
          target: selectedNativeTarget({ platform: "macos" }),
        },
      }),
    );

    await init({ yes: true });

    expect(ctx.framework.name).toBe("macOS (Swift)");
    expect(scaffoldMod.scaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        framework: expect.objectContaining({ name: "macOS (Swift)" }),
      }),
    );
    expect(captured.err).toContain("Detected");
    expect(captured.err).toContain("macOS (Swift)");
    expect(captured.err).not.toContain("iOS (Swift)");
  });

  test("rejects iOS-only apply flags for a non-iOS project before authentication", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await expect(init({ target: "MyApp" })).rejects.toThrow(
      "--target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, and --prebuilt-auth-ui apply only to native Apple projects",
    );

    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("rejects agent --app before project mutation when authentication is unavailable", async () => {
    setup({ isAgent: true, email: null });

    await expect(init({ app: "app_requested", yes: true })).rejects.toThrow(
      "--app requires authentication",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
    expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid-prefix", "sk_test_sensitive_invalid", 401, "invalid Platform API key"],
    ["unauthorized", "ak_test_sensitive_unauthorized", 403, "unauthorized Platform API key"],
  ])("rejects an %s before native project mutation", async (_case, key, status, reason) => {
    const previous = process.env.CLERK_PLATFORM_API_KEY;
    process.env.CLERK_PLATFORM_API_KEY = key;
    try {
      const { captured } = setup({ isAgent: true, email: null });
      track(
        spyOn(plapiMod, "listApplications").mockRejectedValue(
          new PlapiError(status, JSON.stringify({ errors: [{ message: reason }] })),
        ),
      );

      await expect(init({ app: "app_requested", yes: true })).rejects.toThrow(
        "--app requires authentication",
      );

      expect(context.gatherContext).not.toHaveBeenCalled();
      expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
      expect(linkMod.link).not.toHaveBeenCalled();
      expect(`${captured.out}\n${captured.err}`).not.toContain(key);
    } finally {
      if (previous === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
      else process.env.CLERK_PLATFORM_API_KEY = previous;
    }
  });

  test("preserves Platform API transport failures before native project mutation", async () => {
    const key = "ak_test_sensitive_transport";
    const previous = process.env.CLERK_PLATFORM_API_KEY;
    process.env.CLERK_PLATFORM_API_KEY = key;
    try {
      const { captured } = setup({ isAgent: true, email: null });
      track(
        spyOn(plapiMod, "listApplications").mockRejectedValue(new Error("network unavailable")),
      );

      await expect(init({ app: "app_requested", yes: true })).rejects.toThrow(
        "network unavailable",
      );

      expect(context.gatherContext).not.toHaveBeenCalled();
      expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
      expect(linkMod.link).not.toHaveBeenCalled();
      expect(`${captured.out}\n${captured.err}`).not.toContain(key);
    } finally {
      if (previous === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
      else process.env.CLERK_PLATFORM_API_KEY = previous;
    }
  });

  test("default unauthenticated agent iOS init fails before local apply", async () => {
    const previous = process.env.CLERK_PLATFORM_API_KEY;
    delete process.env.CLERK_PLATFORM_API_KEY;
    try {
      setup({ isAgent: true, email: null });
      spyOn(context, "gatherContext").mockResolvedValue(nativeIOSContext());

      await expect(init({ yes: true })).rejects.toThrow(
        "Native Apple setup in agent mode requires valid Clerk authentication",
      );

      expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
      expect(linkMod.link).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.CLERK_PLATFORM_API_KEY = previous;
    }
  });

  test("requires a confirmed App ID Prefix before an agent creates or links a new application", async () => {
    setup({ isAgent: true, email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        requiresLinkedApp: true,
        nativeReadiness: {
          ...FAKE_IOS_NATIVE_READINESS,
          target: selectedNativeTarget({
            appIdPrefix: { status: "missing", source: "literal-entitlements" },
          }),
        },
        unverifiedAppIdPrefixSuggestion: {
          source: "xcode-development-team",
          value: "ABCDE12345",
        },
      }),
    );

    await expect(init({ yes: true })).rejects.toThrow(
      "Ask the user whether to use ABCDE12345 or enter a different App ID Prefix",
    );

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).not.toHaveBeenCalled();
    expect(nativeRemoteMod.prepareIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
  });

  test("requires --app in agent mode for a preserved custom key source", async () => {
    setup({ isAgent: true, email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue(undefined);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        requiresLinkedApp: true,
        requiresDevelopmentKey: false,
        requiresExplicitApplication: true,
      }),
    );

    await expect(init({ yes: true })).rejects.toThrow(
      "requires explicit Clerk application selection",
    );

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).not.toHaveBeenCalled();
    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
  });

  test("names an agent-created Clerk application after the selected Xcode target", async () => {
    setup({ isAgent: true, email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_test" } } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        targetName: "AnotherPromptTest",
        requiresLinkedApp: true,
        nativeReadiness: {
          ...FAKE_IOS_NATIVE_READINESS,
          target: selectedNativeTarget({
            projectPath: "ContainerProject.xcodeproj",
            targetName: "AnotherPromptTest",
            appIdPrefix: { status: "missing", source: "literal-entitlements" },
          }),
        },
      }),
    );

    await init({ yes: true, appIdPrefix: "CONFIRM123" });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: iosCtx.cwd,
      createIfMissing: "AnotherPromptTest",
      skipAutolink: true,
    });
    expect(nativeRemoteMod.prepareIOSNativeRemoteSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        root: FAKE_IOS_NATIVE_READINESS.root,
        appIdPrefix: "CONFIRM123",
        applicationLinkChange: "created-and-linked",
      }),
    );
  });

  test("lets an explicit existing app supply its registered prefix without auto-creation", async () => {
    setup({ isAgent: true, email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_existing" } } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        requiresLinkedApp: true,
        nativeReadiness: {
          ...FAKE_IOS_NATIVE_READINESS,
          target: selectedNativeTarget({
            appIdPrefix: { status: "missing", source: "literal-entitlements" },
          }),
        },
      }),
    );
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_existing",
      instanceId: "ins_existing",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan({
        applicationId: "app_existing",
        instanceId: "ins_existing",
        appIdPrefix: "REGIST1234",
        nativeApi: "satisfied",
        registration: "satisfied",
        status: "satisfied",
        actions: [],
      }),
    );

    await init({ yes: true, app: "app_existing" });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_existing",
      cwd: iosCtx.cwd,
      createIfMissing: undefined,
      skipAutolink: true,
    });
    expect(nativeRemoteMod.prepareIOSNativeRemoteSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        root: FAKE_IOS_NATIVE_READINESS.root,
        appIdPrefix: undefined,
        applicationLinkChange: "link-updated",
      }),
    );
  });

  test("does not auto-create a replacement when an existing iOS link disappears", async () => {
    setup({ isAgent: true, email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce({ profile: { appId: "app_existing" } } as never)
      .mockResolvedValue(undefined);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({ requiresLinkedApp: true }),
    );

    await expect(init({ yes: true })).rejects.toThrow(
      "The Clerk application link could not be verified",
    );

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: iosCtx.cwd,
      createIfMissing: undefined,
      skipAutolink: true,
    });
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).not.toHaveBeenCalled();
  });

  test("rejects --allow-dirty with --dry-run before project work", async () => {
    setup();

    await expect(init({ dryRun: true, allowDirty: true })).rejects.toThrow(
      "--allow-dirty applies only when clerk init is making local changes",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
  });

  test("rejects an invalid App ID Prefix before project work", async () => {
    setup();

    await expect(init({ appIdPrefix: "   " })).rejects.toThrow(
      "--app-id-prefix must contain exactly 10 ASCII letters or numbers",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
  });

  test("rejects --app-id-prefix with local-only dry-run", async () => {
    setup();

    await expect(init({ dryRun: true, appIdPrefix: "LEGACY1234" })).rejects.toThrow(
      "--app-id-prefix cannot be combined with --dry-run",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
  });

  test("rejects a known non-iOS override before bootstrapping or project work", async () => {
    setup();
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(FAKE_CTX.framework);

    await expect(init({ framework: "next", target: "MyApp" })).rejects.toThrow(
      "--target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, and --prebuilt-auth-ui apply only to native Apple projects",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("never bootstraps when an iOS existing-project flag is present", async () => {
    setup();
    spyOn(context, "gatherContext").mockResolvedValue(null);

    await expect(init({ target: "MyApp" })).rejects.toThrow(
      "Could not detect an existing native Apple project",
    );

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("rejects --starter with iOS existing-project flags before project work", async () => {
    setup();

    await expect(init({ starter: true, target: "MyApp" })).rejects.toThrow(
      "require an existing native Apple project",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test.each([
    [{ keyless: true }, "--keyless is not supported for native Apple projects"],
    [{ template: "native" as const }, "--template only applies to keyless applications"],
    [{ fresh: true }, "--fresh only applies to keyless applications"],
  ])("rejects iOS-incompatible flags before Xcode apply", async (flags, message) => {
    setup();
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    });

    await expect(init({ yes: true, ...flags })).rejects.toThrow(message);

    expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("native iOS skips npm SDK install and does not create an unused env file", async () => {
    setup({ email: "test@test.com" });

    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    const recover = spyOn(iosFileTransactionMod, "recoverIOSFileTransactions").mockResolvedValue(
      undefined,
    );
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true });

    expect(recover).toHaveBeenCalledWith(iosCtx.cwd);
    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledWith({
      root: iosCtx.cwd,
      target: undefined,
      yes: true,
      agent: false,
      allowDirty: false,
      signInWithApple: undefined,
      prebuiltAuthUI: undefined,
    });
    expect(heuristics.installSdk).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).not.toHaveBeenCalled();
  });

  test("forwards only an explicit prebuilt AuthView opt-in to iOS preflight", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);

    await init({ yes: true, prebuiltAuthUI: true });

    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        root: iosCtx.cwd,
        yes: true,
        prebuiltAuthUI: true,
        signInWithApple: undefined,
      }),
    );
    expect(nativeAppleMod.prepareIOSNativeAppleConnection).not.toHaveBeenCalled();
    expect(nativeAppleMod.applyIOSNativeAppleConnection).not.toHaveBeenCalled();
  });

  test("normalizes Commander's prebuiltAuthUi option before iOS preflight", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);

    await init({ yes: true, prebuiltAuthUi: true });

    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        root: iosCtx.cwd,
        yes: true,
        prebuiltAuthUI: true,
      }),
    );
  });

  test("promotes the pre-authorized Apple entitlement when AuthView exposes Apple", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const conditionalApplePlan = iosAppleEntitlementPlan();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({ root: iosCtx.cwd }),
      prebuiltAuthAppleEntitlementPlan: conditionalApplePlan,
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    const environment = spyOn(fapiMod, "fetchUserSettings").mockResolvedValue({
      social: {
        oauth_apple: {
          enabled: true,
          authenticatable: true,
          strategy: "oauth_apple",
        },
      },
    } as never);
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );

    await init({ yes: true, prebuiltAuthUI: true });

    expect(environment).toHaveBeenCalledWith("example.clerk.accounts.dev", {});
    expect(environment).toHaveBeenCalledTimes(2);
    expect(commitLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        appleEntitlementPlan: conditionalApplePlan,
        prebuiltAuthAppleEntitlementPlan: undefined,
      }),
      undefined,
    );
    expect(setupResult.appleEntitlementPlan).toBeUndefined();
    expect(setupResult.prebuiltAuthAppleEntitlementPlan).toBe(conditionalApplePlan);
    expect(nativeAppleMod.prepareIOSNativeAppleConnection).not.toHaveBeenCalled();
  });

  test("drops the conditional Apple entitlement when AuthView will not expose Apple", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({
        status: "satisfied",
        root: iosCtx.cwd,
      }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    spyOn(fapiMod, "fetchUserSettings").mockResolvedValue({
      social: {
        oauth_apple: {
          enabled: true,
          authenticatable: false,
          strategy: "oauth_apple",
        },
      },
    } as never);
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );

    await init({ yes: true, prebuiltAuthUI: true });

    expect(commitLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        prebuiltAuthAppleEntitlementPlan: undefined,
      }),
      undefined,
    );
    expect(commitLocal.mock.calls[0]?.[0].appleEntitlementPlan).toBeUndefined();
  });

  test("fails closed when AuthView Apple availability changes before local commit", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({ root: iosCtx.cwd }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    const environment = spyOn(fapiMod, "fetchUserSettings")
      .mockResolvedValueOnce({
        social: {
          oauth_apple: {
            enabled: true,
            authenticatable: false,
            strategy: "oauth_apple",
          },
        },
      } as never)
      .mockResolvedValueOnce({
        social: {
          oauth_apple: {
            enabled: true,
            authenticatable: true,
            strategy: "oauth_apple",
          },
        },
      } as never);

    await expect(init({ yes: true, prebuiltAuthUI: true })).rejects.toThrow(
      "AuthView methods changed while the approved native Apple setup was being prepared",
    );

    expect(environment).toHaveBeenCalledTimes(2);
    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(nativeRemoteMod.applyIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(nativeAppleMod.applyIOSNativeAppleConnection).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(VALID_DEVELOPMENT_KEY);
  });

  test("blocks before local or remote mutation when required AuthView Apple capability is unsafe", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({ root: iosCtx.cwd }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan({
        status: "blocked",
        files: [],
        actions: [],
        blockers: [
          {
            code: "unsupported-entitlements",
            message: "Review the entitlements file.",
          },
        ],
      }),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    spyOn(fapiMod, "fetchUserSettings").mockResolvedValue({
      social: {
        oauth_apple: {
          enabled: true,
          authenticatable: true,
          strategy: "oauth_apple",
        },
      },
    } as never);

    await expect(init({ yes: true, prebuiltAuthUI: true })).rejects.toThrow(
      "required selected-target entitlement could not be prepared safely",
    );

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(nativeRemoteMod.prepareIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(nativeRemoteMod.applyIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(VALID_DEVELOPMENT_KEY);
  });

  test("redacts malformed or failed AuthView environment responses", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({
        status: "satisfied",
        root: iosCtx.cwd,
      }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    const secret = "provider-secret-must-not-escape";
    spyOn(fapiMod, "fetchUserSettings").mockResolvedValue({
      social: {
        oauth_apple: {
          enabled: "yes",
          authenticatable: true,
          strategy: "oauth_apple",
          client_secret: secret,
        },
      },
    } as never);

    await expect(init({ yes: true, prebuiltAuthUI: true })).rejects.toThrow(
      "Apple sign-in settings could not be safely determined",
    );

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(nativeRemoteMod.prepareIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(secret);
    expect(`${captured.out}\n${captured.err}`).not.toContain(VALID_DEVELOPMENT_KEY);
  });

  test("omits unexpected AuthView inspection details from debug output", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      prebuiltAuthRequested: true,
      prebuiltAuthActive: true,
      prebuiltAuthPlan: iosPrebuiltAuthPlan({
        status: "satisfied",
        root: iosCtx.cwd,
      }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: VALID_DEVELOPMENT_KEY,
    });
    const sensitiveBearer = "Bearer ak_AUTH_VIEW_TOKEN_MUST_NOT_ESCAPE";
    spyOn(fapiMod, "fetchUserSettings").mockRejectedValue(
      new Error(`request failed with ${sensitiveBearer}`),
    );

    const previousLogLevel = getLogLevel();
    try {
      setLogLevel("debug");
      await expect(init({ yes: true, prebuiltAuthUI: true })).rejects.toThrow(
        "AuthView methods could not be inspected safely",
      );
    } finally {
      setLogLevel(previousLogLevel);
    }

    expect(captured.err).toContain(
      "Could not inspect AuthView authentication methods; underlying error details were omitted.",
    );
    expect(`${captured.out}\n${captured.err}`).not.toContain(sensitiveBearer);
  });

  test("passes the linked development key to the approved iOS setup", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: true,
    });
    const preflightSpy = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const linkSpy = spyOn(linkMod, "link").mockResolvedValue(undefined);
    const resolveKeysSpy = spyOn(
      iosDevelopmentKeyMod,
      "resolveIOSDevelopmentPublicKey",
    ).mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: "pk_test_redacted",
    });
    const applyPlannedSpy = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );
    const scaffoldSpy = spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Finish the remaining iOS setup"],
    });

    await init({ yes: true });

    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).toHaveBeenCalledWith("app_test");
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).toHaveBeenCalledTimes(1);
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(
      setupResult,
      "pk_test_redacted",
    );
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(preflightSpy.mock.invocationCallOrder[0]).toBeLessThan(
      linkSpy.mock.invocationCallOrder[0]!,
    );
    expect(linkSpy.mock.invocationCallOrder[0]).toBeLessThan(
      resolveKeysSpy.mock.invocationCallOrder[0]!,
    );
    expect(applyPlannedSpy.mock.invocationCallOrder[0]).toBeLessThan(
      scaffoldSpy.mock.invocationCallOrder[0]!,
    );
  });

  test("audits remote native state before local commit and applies it afterward", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
      unverifiedAppIdPrefixSuggestion: {
        source: "xcode-development-team",
        value: "ABCDE12345",
      },
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    const resolveKeys = spyOn(
      iosDevelopmentKeyMod,
      "resolveIOSDevelopmentPublicKey",
    ).mockResolvedValue({
      applicationId: "app_test",
      instanceId: "ins_test",
      publishableKey: "pk_test_must_not_be_forwarded",
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const prepareRemote = spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan(),
    );
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );
    const applyRemote = spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockResolvedValue(
      undefined,
    );
    const scaffold = spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: [],
    });

    await init({ yes: true, appIdPrefix: "LEGACY1234" });

    expect(prepareRemote).toHaveBeenCalledWith({
      applicationId: "app_test",
      instanceId: "ins_test",
      root: setupResult.nativeReadiness.root,
      target: setupResult.nativeReadiness.target,
      appIdPrefix: "LEGACY1234",
      unverifiedAppIdPrefixSuggestion: setupResult.unverifiedAppIdPrefixSuggestion,
      agent: false,
      yes: true,
    });
    expect(commitLocal).toHaveBeenCalledWith(setupResult, undefined);
    expect(applyRemote).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ revalidateLocalPreconditions: expect.any(Function) }),
    );
    expect(resolveKeys.mock.invocationCallOrder[0]).toBeLessThan(
      prepareRemote.mock.invocationCallOrder[0]!,
    );
    expect(prepareRemote.mock.invocationCallOrder[0]).toBeLessThan(
      commitLocal.mock.invocationCallOrder[0]!,
    );
    expect(commitLocal.mock.invocationCallOrder[0]).toBeLessThan(
      applyRemote.mock.invocationCallOrder[0]!,
    );
    expect(applyRemote.mock.invocationCallOrder[0]).toBeLessThan(
      scaffold.mock.invocationCallOrder[0]!,
    );
    expect(scaffold).toHaveBeenCalledWith(expect.objectContaining({ iosNativeRemoteReady: true }));
  });

  test("applies an explicitly requested native Apple setup only after local and native readiness", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const stages = trackStages();
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      appleEntitlementPlan: iosAppleEntitlementPlan(),
      nativeAppleRequested: true,
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    const preflightLocal = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const prepareNative = spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan({ bundleIdentifier: "com.Example.MyApp" }),
    );
    const applePlan = iosNativeApplePlan();
    const prepareApple = spyOn(nativeAppleMod, "prepareIOSNativeAppleConnection").mockResolvedValue(
      applePlan,
    );
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );
    const applyNative = spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockResolvedValue(
      undefined,
    );
    const applyApple = spyOn(nativeAppleMod, "applyIOSNativeAppleConnection").mockResolvedValue(
      undefined,
    );
    const scaffold = spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: [],
    });

    await init({ yes: true, signInWithApple: true });

    expect(preflightLocal).toHaveBeenCalledWith(expect.objectContaining({ signInWithApple: true }));
    expect(prepareApple).toHaveBeenCalledWith({
      applicationId: "app_test",
      instanceId: "ins_test",
      platform: "ios",
      bundleIdentifier: "com.Example.MyApp",
      nativeApplicationReady: true,
      requested: true,
      agent: false,
      yes: true,
    });
    expect(prepareNative.mock.invocationCallOrder[0]).toBeLessThan(
      prepareApple.mock.invocationCallOrder[0]!,
    );
    expect(prepareApple.mock.invocationCallOrder[0]).toBeLessThan(
      commitLocal.mock.invocationCallOrder[0]!,
    );
    expect(commitLocal.mock.invocationCallOrder[0]).toBeLessThan(
      applyNative.mock.invocationCallOrder[0]!,
    );
    expect(applyNative.mock.invocationCallOrder[0]).toBeLessThan(
      applyApple.mock.invocationCallOrder[0]!,
    );
    expect(scaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        iosNativeRemoteReady: true,
        iosNativeAppleReady: true,
      }),
    );
    expect(stages()).toEqual([
      "flags",
      "detect",
      "strategy",
      "ios_inspect",
      "link",
      "keys",
      "ios_native_plan",
      "ios_apple_plan",
      "ios_local_setup",
      "ios_native_setup",
      "ios_apple_setup",
      "scaffold",
      "already_set_up",
    ]);
    expect(`${captured.out}\n${captured.err}`).not.toContain("pk_test_must_not_be_forwarded");
  });

  test("does not mutate Apple state when the application link changes during native setup", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      appleEntitlementPlan: iosAppleEntitlementPlan(),
      nativeAppleRequested: true,
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    let linkedApplicationId = "app_test";
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockImplementation(
      async () => ({ profile: { appId: linkedApplicationId } }) as never,
    );
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(iosRemotePlan());
    spyOn(nativeAppleMod, "prepareIOSNativeAppleConnection").mockResolvedValue(
      iosNativeApplePlan(),
    );
    spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(undefined);
    const applyNative = spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockImplementation(
      async () => {
        linkedApplicationId = "app_changed";
      },
    );
    const applyApple = spyOn(nativeAppleMod, "applyIOSNativeAppleConnection").mockResolvedValue(
      undefined,
    );

    await expect(init({ yes: true, signInWithApple: true })).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining(
        "completed local and Clerk Native Application changes remain intact, but no native Apple connection changes were made",
      ),
    });

    expect(applyNative).toHaveBeenCalledTimes(1);
    expect(applyApple).not.toHaveBeenCalled();
  });

  test("does not opt into native Apple merely because --yes was supplied", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({
        appleEntitlementPlan: iosAppleEntitlementPlan({
          status: "satisfied",
          actions: [],
        }),
        nativeAppleRequested: false,
        requiresLinkedApp: true,
        requiresDevelopmentKey: false,
      }),
    );

    await init({ yes: true });

    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledWith(
      expect.objectContaining({ signInWithApple: undefined }),
    );
    expect(nativeAppleMod.prepareIOSNativeAppleConnection).not.toHaveBeenCalled();
    expect(nativeAppleMod.applyIOSNativeAppleConnection).not.toHaveBeenCalled();
  });

  test("does not commit local iOS files when the remote readiness audit blocks", async () => {
    setup({ email: "test@test.com" });
    const stages = trackStages();
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockRejectedValue(
      new Error("conflicting registration"),
    );

    await expect(init({ yes: true })).rejects.toThrow("conflicting registration");

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(nativeRemoteMod.applyIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(stages().at(-1)).toBe("ios_native_plan");
  });

  test("does not mutate remote state when the approved local transaction fails", async () => {
    setup({ email: "test@test.com" });
    const stages = trackStages();
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(iosRemotePlan());
    spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockRejectedValue(
      new Error("stale local source"),
    );

    await expect(init({ yes: true })).rejects.toThrow("stale local source");

    expect(nativeRemoteMod.applyIOSNativeRemoteSetup).not.toHaveBeenCalled();
    expect(stages().at(-1)).toBe("ios_local_setup");
  });

  test("does not mutate native state when the application link changes during local commit", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    let linkedApplicationId = "app_test";
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockImplementation(
      async () => ({ profile: { appId: linkedApplicationId } }) as never,
    );
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(iosRemotePlan());
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockImplementation(
      async () => {
        linkedApplicationId = "app_changed";
      },
    );
    const applyRemote = spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockResolvedValue(
      undefined,
    );

    await expect(init({ yes: true })).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining(
        "Local changes remain intact, but no Clerk Native Application changes were made",
      ),
    });

    expect(commitLocal).toHaveBeenCalledTimes(1);
    expect(applyRemote).not.toHaveBeenCalled();
    expect(nativeAppleMod.applyIOSNativeAppleConnection).not.toHaveBeenCalled();
  });

  test("does not mutate native state when a secondary platform identity changes during local commit", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(iosRemotePlan());
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );
    spyOn(iosPlatformViewsMod, "reinspectIOSPlatformViews").mockResolvedValue({
      status: "ready",
      snapshot: {
        ...FAKE_IOS_PLATFORM_VIEWS,
        bundleIdentifier: "com.example.changed",
      },
    });
    const applyRemote = spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockResolvedValue(
      undefined,
    );

    await expect(init({ yes: true })).rejects.toMatchObject({
      code: ERROR_CODE.IOS_SETUP_STALE,
      message: expect.stringContaining(
        "Local changes remain intact, but no Clerk Native Application changes were made",
      ),
    });

    expect(commitLocal).toHaveBeenCalledTimes(1);
    expect(applyRemote).not.toHaveBeenCalled();
    expect(nativeAppleMod.applyIOSNativeAppleConnection).not.toHaveBeenCalled();
  });

  test("reports partial remote failure without claiming the local setup was rolled back", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const stages = trackStages();
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(iosRemotePlan());
    const commitLocal = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockResolvedValue(
      undefined,
    );
    const sensitiveBearer = "Bearer ak_NATIVE_RECONCILIATION_TOKEN_MUST_NOT_ESCAPE";
    spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockRejectedValue(
      new Error(`remote mutation failed with ${sensitiveBearer}`),
    );

    const previousLogLevel = getLogLevel();
    try {
      setLogLevel("debug");
      await expect(init({ yes: true })).rejects.toMatchObject({
        code: ERROR_CODE.IOS_REMOTE_APPLY_FAILED,
        message: expect.stringContaining("Local changes remain intact; rerun clerk init"),
      });
    } finally {
      setLogLevel(previousLogLevel);
    }

    expect(commitLocal).toHaveBeenCalledTimes(1);
    expect(stages().at(-1)).toBe("ios_native_setup");
    expect(captured.err).toContain(
      "Could not reconcile Clerk Native Application settings; underlying error details were omitted.",
    );
    expect(`${captured.out}\n${captured.err}`).not.toContain(sensitiveBearer);
  });

  test("does not write a key when the linked app changes during resolution", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_linked" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({ requiresLinkedApp: true, requiresDevelopmentKey: true }),
    );
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_changed",
      instanceId: "ins_changed",
      publishableKey: "pk_test_redacted",
    });

    await expect(init({ yes: true })).rejects.toThrow(
      "linked Clerk application changed while its native publishable key was being resolved",
    );

    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledTimes(1);
    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("does not apply an approved iOS plan with a production instance key", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const productionKey = `pk_live_${Buffer.from("production.clerk.example$").toString("base64")}`;
    const setupResult = iosSetupResult({ requiresLinkedApp: true });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_production" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockRejectedValue(
      new Error(
        "Automatic iOS configuration is limited to the linked development instance. No local setup changes were written.",
      ),
    );

    await expect(init({ yes: true })).rejects.toThrow("limited to the linked development instance");

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(productionKey);
  });

  test("does not commit when the local app link changes after key resolution", async () => {
    setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const setupResult = iosSetupResult({ requiresLinkedApp: true });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce({ profile: { appId: "app_selected" } } as never)
      .mockResolvedValueOnce({ profile: { appId: "app_selected" } } as never)
      .mockResolvedValueOnce({ profile: { appId: "app_changed" } } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosDevelopmentKeyMod, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
      applicationId: "app_selected",
      instanceId: "ins_selected",
      publishableKey: "pk_test_redacted",
    });

    await expect(init({ yes: true })).rejects.toThrow(
      "local Clerk application link changed before the approved native Apple setup",
    );

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
  });

  test("preserves a custom key source after the developer selects its application", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const linkedKey = `pk_test_${Buffer.from("selected.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_selected" },
    } as never);
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresExplicitApplication: true,
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const resolveKeys = spyOn(
      iosDevelopmentKeyMod,
      "resolveIOSDevelopmentPublicKey",
    ).mockResolvedValue({
      applicationId: "app_selected",
      instanceId: "ins_selected",
      publishableKey: linkedKey,
    });
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan({
        applicationId: "app_selected",
        instanceId: "ins_selected",
      }),
    );
    await init({ yes: true, app: "app_selected" });

    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(resolveKeys).toHaveBeenCalledWith("app_selected");
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_selected",
      cwd: iosCtx.cwd,
      createIfMissing: undefined,
      skipAutolink: true,
      requireExistingAppSelection: true,
    });
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(setupResult, linkedKey);
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(linkedKey);
  });

  test("an explicit app with no or a different local profile proceeds when the frozen key matches", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const key = `pk_test_${Buffer.from("explicit-match.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce({ profile: { appId: "app_previous" } } as never)
      .mockResolvedValueOnce({ profile: { appId: "app_previous" } } as never)
      .mockResolvedValue({ profile: { appId: "app_requested" } } as never);
    const resolveKeys = spyOn(
      iosDevelopmentKeyMod,
      "resolveIOSDevelopmentPublicKey",
    ).mockResolvedValue({
      applicationId: "app_requested",
      instanceId: "ins_requested",
      publishableKey: key,
    });
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresExplicitApplication: true,
    });
    const localApply = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan({
        applicationId: "app_requested",
        instanceId: "ins_requested",
      }),
    );

    await init({ yes: true, app: "app_requested" });

    expect(localApply.mock.invocationCallOrder[0]).toBeLessThan(
      resolveKeys.mock.invocationCallOrder[0]!,
    );
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_requested",
      cwd: iosCtx.cwd,
      createIfMissing: undefined,
      skipAutolink: true,
      requireExistingAppSelection: true,
    });
    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(setupResult, key);
    expect(`${captured.out}\n${captured.err}`).not.toContain(key);
  });

  test("reuses the frozen explicit key after a profile race without cwd-based resolution", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const key = `pk_test_${Buffer.from("frozen.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ profile: { appId: "app_raced" } } as never)
      .mockResolvedValue({ profile: { appId: "app_requested" } } as never);
    const resolveKeys = spyOn(
      iosDevelopmentKeyMod,
      "resolveIOSDevelopmentPublicKey",
    ).mockResolvedValue({
      applicationId: "app_requested",
      instanceId: "ins_requested",
      publishableKey: key,
    });
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      requiresDevelopmentKey: true,
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(nativeRemoteMod, "prepareIOSNativeRemoteSetup").mockResolvedValue(
      iosRemotePlan({
        applicationId: "app_requested",
        instanceId: "ins_requested",
      }),
    );

    await init({ yes: true, app: "app_requested" });

    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(resolveKeys).toHaveBeenCalledWith("app_requested");
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(setupResult, key);
    expect(`${captured.out}\n${captured.err}`).not.toContain(key);
  });

  test("native framework skips the agent skills install prompt", async () => {
    setup({ email: "test@test.com" });

    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true });

    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("--framework ios without package.json does not trigger bootstrap", async () => {
    setup({ email: "test@test.com" });

    const iosFramework = {
      dep: "ios",
      name: "iOS (Swift)",
      sdk: "ClerkKit",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "swift" as const,
    };
    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: iosFramework,
    };
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(iosFramework);
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(context, "hasPackageJson").mockResolvedValue(false);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true, framework: "ios" });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(iosDevelopmentKeyMod.resolveIOSDevelopmentPublicKey).not.toHaveBeenCalled();
  });
});
