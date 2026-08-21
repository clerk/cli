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
  plapiMod,
  fapiMod,
  FAKE_IOS_NATIVE_READINESS,
} from "../../test/lib/init-harness.ts";
import { init } from "./index.ts";
import { PlapiError } from "../../lib/errors.ts";
import type { IOSLocalSetupResult } from "./ios/apply.ts";
import type { IOSAppleEntitlementPlan } from "./ios/apple-entitlement.ts";
import type { IOSNativeApplePlan } from "./ios/native-apple.ts";
import type { IOSNativeRemotePlan } from "./ios/native-remote.ts";
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
    files: [{ path: "MyApp/MyApp.entitlements", operation: "modify", expectedHash: "hash" }],
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
    nativeReadiness: FAKE_IOS_NATIVE_READINESS,
    prebuiltAuthRequested: false,
    prebuiltAuthActive: false,
    nativeAppleRequested: false,
    requiresLinkedApp: false,
    requiresDevelopmentKey:
      overrides.requiresDevelopmentKey ?? overrides.requiresLinkedApp ?? false,
    verifiesExistingKey: false,
    ...overrides,
  };
}

describe("init iOS", () => {
  const { setup, track } = useInitHarness();
  test("rejects iOS-only apply flags for a non-iOS project before authentication", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await expect(init({ target: "MyApp" })).rejects.toThrow(
      "--target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, and --prebuilt-auth-ui apply only to native iOS projects",
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
        "Native iOS setup in agent mode requires valid Clerk authentication",
      );

      expect(iosApplyMod.applyIOSLocalSetup).not.toHaveBeenCalled();
      expect(linkMod.link).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.CLERK_PLATFORM_API_KEY = previous;
    }
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
      "--app-id-prefix must contain between 1 and 255 characters",
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
      "--target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, and --prebuilt-auth-ui apply only to native iOS projects",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("never bootstraps when an iOS existing-project flag is present", async () => {
    setup();
    spyOn(context, "gatherContext").mockResolvedValue(null);

    await expect(init({ target: "MyApp" })).rejects.toThrow(
      "Could not detect an existing native iOS project",
    );

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("rejects --starter with iOS existing-project flags before project work", async () => {
    setup();

    await expect(init({ starter: true, target: "MyApp" })).rejects.toThrow(
      "require an existing native iOS project",
    );

    expect(context.gatherContext).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test.each([
    [{ keyless: true }, "--keyless is not supported for iOS"],
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
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true });

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
    expect(pullMod.resolveEnvironmentKeys).not.toHaveBeenCalled();
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
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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
      prebuiltAuthPlan: iosPrebuiltAuthPlan({ status: "satisfied", root: iosCtx.cwd }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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
      "AuthView methods changed while the approved iOS setup was being prepared",
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
        blockers: [{ code: "unsupported-entitlements", message: "Review the entitlements file." }],
      }),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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
      prebuiltAuthPlan: iosPrebuiltAuthPlan({ status: "satisfied", root: iosCtx.cwd }),
      prebuiltAuthAppleEntitlementPlan: iosAppleEntitlementPlan(),
      requiresLinkedApp: true,
      requiresDevelopmentKey: false,
    });
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_test" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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

  test("wires a linked development key directly when iOS preflight proves a runtime sink", async () => {
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
    const runtimeKeyPlan = {
      schemaVersion: 1 as const,
      kind: "clerk-ios-runtime-key" as const,
      status: "ready" as const,
      root: iosCtx.cwd,
      projectPath: "MyApp.xcodeproj",
      targetId: "TARGET",
      localSecretsPath: "MyApp/LocalSecrets.plist",
      gitignorePath: ".gitignore",
      gitignoreRule: "/MyApp/LocalSecrets.plist",
      expectedLocalSecretsHash: "source-hash",
      expectedGitignoreHash: "ignore-hash",
      changesGitignore: true,
      actions: ["Set the redacted publishable key."],
      blockers: [],
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const setupResult = iosSetupResult({
      runtimeKeyPlan,
      requiresLinkedApp: true,
    });
    const preflightSpy = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const linkSpy = spyOn(linkMod, "link").mockResolvedValue(undefined);
    const resolveKeysSpy = spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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

    expect(pullMod.resolveEnvironmentKeys).toHaveBeenCalledWith({
      app: "app_test",
      cwd: iosCtx.cwd,
    });
    expect(pullMod.resolveEnvironmentKeys).toHaveBeenCalledTimes(1);
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
    const resolveKeys = spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_test",
      instanceId: "ins_test",
      instanceLabel: "development",
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
      target: setupResult.nativeReadiness.target,
      appIdPrefix: "LEGACY1234",
      unverifiedAppIdPrefixSuggestion: setupResult.unverifiedAppIdPrefixSuggestion,
      agent: false,
      yes: true,
    });
    expect(commitLocal).toHaveBeenCalledWith(setupResult, undefined);
    expect(applyRemote).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
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
      iosRemotePlan(),
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
      bundleIdentifier: "com.example.MyApp",
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
      expect.objectContaining({ iosNativeRemoteReady: true, iosNativeAppleReady: true }),
    );
    expect(`${captured.out}\n${captured.err}`).not.toContain("pk_test_must_not_be_forwarded");
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
        appleEntitlementPlan: iosAppleEntitlementPlan({ status: "satisfied", actions: [] }),
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
  });

  test("does not mutate remote state when the approved local transaction fails", async () => {
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
    spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockRejectedValue(
      new Error("stale local source"),
    );

    await expect(init({ yes: true })).rejects.toThrow("stale local source");

    expect(nativeRemoteMod.applyIOSNativeRemoteSetup).not.toHaveBeenCalled();
  });

  test("reports partial remote failure without claiming the local setup was rolled back", async () => {
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
    spyOn(nativeRemoteMod, "applyIOSNativeRemoteSetup").mockRejectedValue(
      new Error("remote mutation failed"),
    );

    await expect(init({ yes: true })).rejects.toThrow(
      "Local changes remain intact; rerun clerk init",
    );

    expect(commitLocal).toHaveBeenCalledTimes(1);
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
    const runtimeKeyPlan = {
      schemaVersion: 1 as const,
      kind: "clerk-ios-runtime-key" as const,
      status: "ready" as const,
      root: iosCtx.cwd,
      projectPath: "MyApp.xcodeproj",
      targetId: "TARGET",
      localSecretsPath: "MyApp/LocalSecrets.plist",
      gitignorePath: ".gitignore",
      gitignoreRule: "/MyApp/LocalSecrets.plist",
      expectedLocalSecretsHash: "source-hash",
      expectedGitignoreHash: "ignore-hash",
      changesGitignore: true,
      actions: ["Set the redacted publishable key."],
      blockers: [],
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_linked" },
    } as never);
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(
      iosSetupResult({ runtimeKeyPlan, requiresLinkedApp: true }),
    );
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_changed",
      instanceId: "ins_changed",
      instanceLabel: "development",
      publishableKey: "pk_test_redacted",
    });

    await expect(init({ yes: true })).rejects.toThrow(
      "linked Clerk application changed while its iOS publishable key was being resolved",
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
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_production",
      instanceId: "ins_production",
      instanceLabel: "production",
      publishableKey: productionKey,
    });

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
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_selected",
      instanceId: "ins_selected",
      instanceLabel: "development",
      publishableKey: "pk_test_redacted",
    });

    await expect(init({ yes: true })).rejects.toThrow(
      "local Clerk application link changed before the approved iOS setup",
    );

    expect(iosApplyMod.applyIOSPlannedLocalSetup).not.toHaveBeenCalled();
  });

  test("rejects an explicit same-profile app when its existing iOS runtime key is stale", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const linkedKey = `pk_test_${Buffer.from("explicit-stale.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_same_profile" },
    } as never);
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      verifiesExistingKey: true,
    });
    const localApply = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const commit = spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockRejectedValue(
      new Error("The existing iOS runtime publishable key does not match the linked app."),
    );
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_same_profile",
      instanceId: "ins_same_profile",
      instanceLabel: "development",
      publishableKey: linkedKey,
    });
    await expect(init({ yes: true, app: "app_same_profile" })).rejects.toThrow(
      "does not match the linked app",
    );

    expect(iosApplyMod.applyIOSLocalSetup).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPublishableKey: expect.anything() }),
    );
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(localApply).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(setupResult, linkedKey);
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(linkedKey);
  });

  test("rejects an implicitly linked profile when its existing iOS runtime key is stale", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const linkedKey = `pk_test_${Buffer.from("implicit-stale.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_implicitly_linked" },
    } as never);
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      verifiesExistingKey: true,
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    spyOn(iosApplyMod, "applyIOSPlannedLocalSetup").mockRejectedValue(
      new Error("The existing iOS runtime publishable key does not match the linked app."),
    );
    spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_implicitly_linked",
      instanceId: "ins_implicitly_linked",
      instanceLabel: "development",
      publishableKey: linkedKey,
    });
    await expect(init({ yes: true })).rejects.toThrow("does not match the linked app");

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(setupResult, linkedKey);
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(`${captured.out}\n${captured.err}`).not.toContain(linkedKey);
  });

  test("matching an existing iOS runtime key is a read-only authenticated no-op", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const linkedKey = `pk_test_${Buffer.from("matching.clerk.example$").toString("base64")}`;
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_matching" },
    } as never);
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      verifiesExistingKey: true,
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);
    const resolveKeys = spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_matching",
      instanceId: "ins_matching",
      instanceLabel: "development",
      publishableKey: linkedKey,
    });
    await init({ yes: true });

    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(resolveKeys).toHaveBeenCalledWith({ app: "app_matching", cwd: iosCtx.cwd });
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
    const resolveKeys = spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_requested",
      instanceId: "ins_requested",
      instanceLabel: "development",
      publishableKey: key,
    });
    const setupResult = iosSetupResult({
      requiresLinkedApp: true,
      verifiesExistingKey: true,
    });
    const localApply = spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);

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
    });
    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(iosApplyMod.applyIOSPlannedLocalSetup).toHaveBeenCalledWith(setupResult, key);
    expect(`${captured.out}\n${captured.err}`).not.toContain(key);
  });

  test("reuses the frozen explicit key after a profile race without cwd-based resolution", async () => {
    const { captured } = setup({ email: "test@test.com" });
    const iosCtx = nativeIOSContext();
    const key = `pk_test_${Buffer.from("frozen.clerk.example$").toString("base64")}`;
    const runtimeKeyPlan = {
      schemaVersion: 1 as const,
      kind: "clerk-ios-runtime-key" as const,
      status: "ready" as const,
      root: iosCtx.cwd,
      projectPath: "MyApp.xcodeproj",
      targetId: "TARGET",
      localSecretsPath: "MyApp/LocalSecrets.plist",
      gitignorePath: ".gitignore",
      gitignoreRule: "/MyApp/LocalSecrets.plist",
      expectedLocalSecretsHash: "source-hash",
      expectedGitignoreHash: "ignore-hash",
      changesGitignore: true,
      actions: ["Set the redacted publishable key."],
      blockers: [],
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ profile: { appId: "app_raced" } } as never)
      .mockResolvedValue({ profile: { appId: "app_requested" } } as never);
    const resolveKeys = spyOn(pullMod, "resolveEnvironmentKeys").mockResolvedValue({
      appId: "app_requested",
      instanceId: "ins_requested",
      instanceLabel: "development",
      publishableKey: key,
    });
    const setupResult = iosSetupResult({
      runtimeKeyPlan,
      requiresLinkedApp: true,
    });
    spyOn(iosApplyMod, "applyIOSLocalSetup").mockResolvedValue(setupResult);

    await init({ yes: true, app: "app_requested" });

    expect(resolveKeys).toHaveBeenCalledTimes(1);
    expect(resolveKeys).toHaveBeenCalledWith({ app: "app_requested", cwd: iosCtx.cwd });
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
    expect(pullMod.resolveEnvironmentKeys).not.toHaveBeenCalled();
  });
});
