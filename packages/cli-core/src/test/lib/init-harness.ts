/**
 * Shared harness for the `clerk init` test files.
 *
 * `init` orchestrates a dozen collaborators, so every test needs the same wall
 * of spies. Keeping that wall here lets the test files split by concern
 * (strategy selection vs. bootstrap plumbing) without duplicating setup.
 *
 * Pure `spyOn` — no `mock.module`, which is process-lifetime in Bun and would
 * leak into other files.
 */

import { afterEach, spyOn } from "bun:test";
import { useCaptureLog } from "./stubs.ts";

export * as loginMod from "../../commands/auth/login.ts";
export * as linkMod from "../../commands/link/index.ts";
export * as pullMod from "../../commands/env/pull.ts";
export * as mode from "../../mode.ts";
export * as config from "../../lib/config.ts";
export * as frameworkMod from "../../lib/framework.ts";
export * as context from "../../commands/init/context.ts";
export * as scaffoldMod from "../../commands/init/scaffold.ts";
export * as previewMod from "../../commands/init/preview.ts";
export * as formatMod from "../../commands/init/format.ts";
export * as scanMod from "../../commands/init/scan.ts";
export * as heuristics from "../../commands/init/heuristics.ts";
export * as skillsMod from "../../commands/init/skills.ts";
export * as bootstrapMod from "../../commands/init/bootstrap.ts";
export * as nextStepsMod from "../../lib/next-steps.ts";
export * as keylessMod from "../../lib/keyless.ts";
export * as keylessTargetMod from "../../lib/keyless-target.ts";
export * as iosApplyMod from "../../commands/init/ios/apply.ts";
export * as nativeRemoteMod from "../../commands/init/ios/native-remote.ts";
export * as nativeAppleMod from "../../commands/init/ios/native-apple.ts";
export * as iosDevelopmentKeyMod from "../../commands/init/ios/development-key.ts";
export * as iosPlatformViewsMod from "../../commands/init/ios/platform-views.ts";
export * as plapiMod from "../../lib/plapi.ts";
export * as fapiMod from "../../lib/fapi.ts";

import * as loginModule from "../../commands/auth/login.ts";
import * as linkModule from "../../commands/link/index.ts";
import * as pullModule from "../../commands/env/pull.ts";
import * as modeModule from "../../mode.ts";
import * as configModule from "../../lib/config.ts";
import * as frameworkModule from "../../lib/framework.ts";
import * as contextModule from "../../commands/init/context.ts";
import * as scaffoldModule from "../../commands/init/scaffold.ts";
import * as previewModule from "../../commands/init/preview.ts";
import * as formatModule from "../../commands/init/format.ts";
import * as scanModule from "../../commands/init/scan.ts";
import * as heuristicsModule from "../../commands/init/heuristics.ts";
import * as skillsModule from "../../commands/init/skills.ts";
import * as bootstrapModule from "../../commands/init/bootstrap.ts";
import * as keylessModule from "../../lib/keyless.ts";
import * as iosApplyModule from "../../commands/init/ios/apply.ts";
import * as nativeRemoteModule from "../../commands/init/ios/native-remote.ts";
import * as nativeAppleModule from "../../commands/init/ios/native-apple.ts";
import * as iosDevelopmentKeyModule from "../../commands/init/ios/development-key.ts";
import * as iosPlatformViewsModule from "../../commands/init/ios/platform-views.ts";
import * as plapiModule from "../../lib/plapi.ts";
import * as fapiModule from "../../lib/fapi.ts";
import {
  IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT,
  type IOSNativeReadinessAudit,
} from "../../commands/init/ios/native-readiness.ts";
import type { IOSPlatformViewsSnapshot } from "../../commands/init/ios/platform-views.ts";

const EMPTY_SWIFT_PLATFORM_SNAPSHOT = {
  evidenceComplete: true,
  status: "absent" as const,
  entryPoints: [],
  importsClerkKit: [],
  importsClerkKitUI: [],
  configureCalls: [],
  appRootEvidence: [],
  environmentInjections: [],
  rootEnvironmentInjections: [],
  environmentConsumers: [],
  authViewReferences: [],
  authFlowReferences: [],
  appleAuthReferences: [],
};

export const FAKE_IOS_PLATFORM_VIEWS: IOSPlatformViewsSnapshot = {
  schemaVersion: 1,
  kind: "clerk-ios-platform-views",
  root: "/tmp/test",
  projectPath: "MyApp.xcodeproj",
  targetId: "TARGET",
  primaryPlatform: "ios",
  supportedPlatforms: ["ios"],
  bundleIdentifier: "com.example.myapp",
  productDecision: "core-only",
  requiresClerkKitUI: false,
  requiresAuthViewCompatibility: false,
  sharedEntryPointPath: null,
  sharedAppRootPath: null,
  platforms: [
    {
      platform: "ios",
      productDecision: "core-only",
      hasAppleEntitlementIntent: false,
      swift: EMPTY_SWIFT_PLATFORM_SNAPSHOT,
    },
  ],
};

export const FAKE_CTX = {
  cwd: "/tmp/test",
  framework: {
    dep: "react",
    name: "React",
    sdk: "@clerk/react",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env" as const,
  },
  typescript: true,
  srcDir: false,
  packageManager: "npm" as const,
  existingClerk: true,
  deps: { react: "^19.0.0" },
  envFile: ".env",
};

export const FAKE_BOOTSTRAP = {
  projectDir: "/tmp/test/my-app",
  projectName: "my-app",
  packageManager: "npm" as const,
};

export const FAKE_IOS_NATIVE_READINESS: IOSNativeReadinessAudit = {
  schemaVersion: 1,
  kind: "clerk-ios-native-readiness",
  root: "/tmp/test",
  target: {
    status: "selected",
    projectPath: "MyApp.xcodeproj",
    targetId: "TARGET",
    targetName: "MyApp",
    platform: "ios",
    bundleIdentifier: { status: "resolved", value: "com.example.MyApp" },
    appIdPrefix: {
      status: "resolved",
      source: "literal-entitlements",
      value: "LEGACY1234",
    },
  },
  associatedDomain: {
    status: "satisfied",
    expectedDomain: "webcredentials:clerk.example.test",
    files: ["MyApp/MyApp.entitlements"],
    automatable: false,
    blockers: [],
  },
  remote: {
    status: "not-inspected",
    reason: "dry-run-does-not-read-remote-state",
    requirement: IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT,
  },
};

type FakeFramework = {
  dep: string;
  name: string;
  sdk: string;
  envVar: string;
  envFile: ".env" | ".env.local";
  supportsKeyless?: boolean;
};

export type FakeCtx = Omit<typeof FAKE_CTX, "framework"> & { framework: FakeFramework };

export const KEYLESS_CTX: FakeCtx = {
  ...FAKE_CTX,
  existingClerk: false,
  framework: { ...FAKE_CTX.framework, supportsKeyless: true },
};

export function mockBootstrapTo(ctx: FakeCtx): void {
  spyOn(contextModule, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(ctx);
}

export function mockExistingProject(ctx: FakeCtx): void {
  spyOn(contextModule, "gatherContext").mockResolvedValue(ctx);
}

export function mockMiddlewareScaffold(): void {
  spyOn(scaffoldModule, "scaffold").mockResolvedValue({
    actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
    postInstructions: [],
  });
}

export interface InitHarness {
  setup: (overrides?: { email?: string | null; apiKey?: boolean; isAgent?: boolean }) => {
    gatherContextSpy: ReturnType<typeof spyOn>;
    captured: ReturnType<typeof useCaptureLog>;
  };
  setupBootstrapSuccess: () => void;
  /** Registers an extra spy so the harness restores it with the rest. */
  track: (spy: ReturnType<typeof spyOn>) => void;
  captured: ReturnType<typeof useCaptureLog>;
}

/**
 * Registers the spy lifecycle for an `init` describe block. Call at describe
 * scope, exactly like `useCaptureLog()`.
 */
export function useInitHarness(): InitHarness {
  let spies: ReturnType<typeof spyOn>[] = [];
  const captured = useCaptureLog();

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  function setup(overrides: { email?: string | null; apiKey?: boolean; isAgent?: boolean } = {}) {
    const email = overrides.email ?? null;
    const apiKey = overrides.apiKey ?? false;
    const agent = overrides.isAgent ?? false;
    const authed = email != null || apiKey;
    const gatherContextSpy = spyOn(contextModule, "gatherContext").mockResolvedValue(null);

    spies = [
      spyOn(modeModule, "isAgent").mockReturnValue(agent),
      spyOn(modeModule, "isHuman").mockReturnValue(!agent),
      spyOn(configModule, "resolveProfile").mockResolvedValue(undefined),
      spyOn(frameworkModule, "lookupFramework").mockReturnValue(null),
      gatherContextSpy,
      spyOn(contextModule, "hasPackageJson").mockResolvedValue(false),
      spyOn(scaffoldModule, "scaffold").mockResolvedValue({ actions: [], postInstructions: [] }),
      spyOn(scaffoldModule, "enrichProjectContext").mockResolvedValue(undefined),
      spyOn(previewModule, "previewPlan").mockReturnValue(undefined),
      spyOn(previewModule, "previewAndConfirm").mockResolvedValue(true),
      spyOn(formatModule, "runFormatters").mockResolvedValue(undefined),
      spyOn(scanModule, "detectAuthLibraries").mockReturnValue(undefined),
      spyOn(scanModule, "scanForIssues").mockResolvedValue([]),
      spyOn(heuristicsModule, "getAuthenticatedEmail").mockResolvedValue(email),
      spyOn(heuristicsModule, "isAuthenticated").mockResolvedValue(authed),
      spyOn(heuristicsModule, "printKeylessInfo").mockReturnValue(undefined),
      spyOn(heuristicsModule, "installSdk").mockResolvedValue(undefined),
      spyOn(heuristicsModule, "installDeps").mockResolvedValue(undefined),
      spyOn(heuristicsModule, "writePlan").mockResolvedValue([]),
      spyOn(heuristicsModule, "checkGitDirty").mockResolvedValue(false),
      spyOn(heuristicsModule, "printOutro").mockReturnValue(undefined),
      spyOn(skillsModule, "installSkills").mockResolvedValue(undefined),
      spyOn(loginModule, "login").mockResolvedValue(undefined as never),
      spyOn(linkModule, "link").mockResolvedValue(undefined),
      spyOn(pullModule, "pull").mockResolvedValue(undefined),
      spyOn(iosDevelopmentKeyModule, "resolveIOSDevelopmentPublicKey").mockResolvedValue({
        applicationId: "app_test",
        instanceId: "ins_test",
        publishableKey: "pk_test_redacted",
      }),
      spyOn(iosPlatformViewsModule, "reinspectIOSPlatformViews").mockResolvedValue({
        status: "ready",
        snapshot: FAKE_IOS_PLATFORM_VIEWS,
      }),
      spyOn(fapiModule, "fetchUserSettings").mockResolvedValue({ social: {} } as never),
      spyOn(bootstrapModule, "promptAndBootstrap").mockResolvedValue(FAKE_BOOTSTRAP),
      spyOn(bootstrapModule, "confirmOverwrite").mockResolvedValue(undefined),
      spyOn(iosApplyModule, "applyIOSLocalSetup").mockResolvedValue({
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
        requiresDevelopmentKey: false,
        requiresExplicitApplication: false,
      }),
      spyOn(iosApplyModule, "applyIOSPlannedLocalSetup").mockResolvedValue(undefined),
      spyOn(nativeRemoteModule, "prepareIOSNativeRemoteSetup").mockResolvedValue({
        schemaVersion: 1,
        kind: "clerk-ios-native-remote-setup",
        status: "satisfied",
        applicationId: "app_test",
        instanceId: "ins_test",
        platform: "ios",
        bundleIdentifier: "com.example.MyApp",
        appIdPrefix: "LEGACY1234",
        nativeApi: "satisfied",
        registration: "satisfied",
        actions: [],
        blockers: [],
      }),
      spyOn(nativeRemoteModule, "applyIOSNativeRemoteSetup").mockResolvedValue(undefined),
      spyOn(nativeAppleModule, "prepareIOSNativeAppleConnection").mockResolvedValue({
        schemaVersion: 1,
        kind: "clerk-ios-native-apple-connection",
        status: "satisfied",
        applicationId: "app_test",
        instanceId: "ins_test",
        bundleIdentifier: "com.example.MyApp",
        connection: "satisfied",
        bundleIdentifierConfiguration: "satisfied",
        current: { enabled: true, authenticatable: true },
        desired: { enabled: true, authenticatable: true },
        actions: [],
        blockers: [],
      }),
      spyOn(nativeAppleModule, "applyIOSNativeAppleConnection").mockResolvedValue(undefined),
      spyOn(plapiModule, "listApplications").mockResolvedValue([]),
      spyOn(keylessModule, "createAccountlessApp").mockResolvedValue({
        publishable_key: "pk_test_stub",
        secret_key: "sk_test_stub",
        claim_url: "/apps/claim?token=stub_token",
      }),
      spyOn(keylessModule, "writeKeysToEnvFile").mockResolvedValue(undefined),
      spyOn(keylessModule, "writeKeylessBreadcrumb").mockResolvedValue(undefined),
    ];

    return { gatherContextSpy, captured };
  }

  function setupBootstrapSuccess(): void {
    const gatherSpy =
      spies.find((s) => s.getMockName?.() === "gatherContext") ??
      spyOn(contextModule, "gatherContext");
    gatherSpy.mockResolvedValueOnce(null).mockResolvedValueOnce(FAKE_CTX);
  }

  function track(spy: ReturnType<typeof spyOn>): void {
    spies.push(spy);
  }

  return { setup, setupBootstrapSuccess, track, captured };
}
