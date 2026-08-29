import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import { ERROR_CODE } from "../../../lib/errors.ts";
import { inspectIOSProject } from "./inspect.ts";
import { applyIOSLocalSetup, applyIOSPlannedLocalSetup } from "./apply.ts";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";
import * as prompts from "../../../lib/prompts.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import type { PbxObjects } from "./pbx.ts";
import {
  addStarterContentViewToFixture,
  authFixtureKey,
  canonicalSwiftUIFixture,
  createCustomFlowWithStarterContent,
  createIsolatedCLIState,
  createUnconfiguredFixture,
  currentAppleConnection,
  resetAppleConfiguration,
  runCLI,
  runCommand,
  temporaryDirectories,
} from "./apply-cli.test-helpers.ts";

setDefaultTimeout(15_000);

describe("clerk init iOS SDK apply", () => {
  const captured = useCaptureLog();

  test("uses exhaustive project discovery before implicitly selecting a target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-exhaustive-apply-selection-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    await createIOSFixture(join(root, "Level0", "Level1", "Level2", "Level3"), {
      complete: true,
    });
    const before = await treeDigest(root);

    expect((await inspectIOSProject(root)).selection.state).toBe("selected");
    await expect(
      applyIOSLocalSetup({
        root,
        yes: true,
        agent: true,
        allowDirty: false,
      }),
    ).rejects.toThrow("More than one native Apple application target is eligible");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("fails closed when exhaustive project discovery reaches its safety bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-incomplete-apply-selection-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const nesting = Array.from({ length: 25 }, (_, index) => `Level${index}`);
    await mkdir(join(root, ...nesting), { recursive: true });
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: true,
        allowDirty: false,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_TARGET_UNRESOLVED,
      message: expect.stringContaining("Xcode project discovery was incomplete"),
    });

    expect(await treeDigest(root)).toEqual(before);
  });

  test("fails closed when a workspace exposes an incomplete project inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-incomplete-workspace-apply-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, localSecrets: true });
    const workspace = join(root, "Broken.xcworkspace");
    await mkdir(workspace);
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      '<Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj" />',
    );
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        yes: true,
        agent: true,
        allowDirty: false,
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODE.IOS_TARGET_UNRESOLVED,
      message: expect.stringContaining("Xcode project discovery was incomplete"),
    });

    expect(await treeDigest(root)).toEqual(before);
  });

  test("keeps a single deeply nested project selected through setup planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-deep-apply-selection-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "Level0", "Level1", "Level2", "Level3");
    await createIOSFixture(projectRoot, { complete: true, localSecrets: true });
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      yes: true,
      agent: true,
      allowDirty: false,
    });

    expect(setup.nativeReadiness.target).toMatchObject({
      status: "selected",
      projectPath: "Level0/Level1/Level2/Level3/MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.appTarget,
      targetName: "MyApp",
    });
    expect(await treeDigest(root)).toEqual(before);
  });

  test("plans a pure macOS app without an Associated Domain action", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-macos-local-setup-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      platform: "macos",
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      yes: true,
      agent: true,
      allowDirty: false,
      prebuiltAuthUI: false,
      signInWithApple: false,
    });

    expect(setup).toMatchObject({
      platform: "macos",
      associatedDomainPlan: undefined,
      nativeReadiness: {
        target: { status: "selected", platform: "macos" },
        associatedDomain: { status: "not-applicable", files: [], blockers: [] },
      },
    });
    expect(await treeDigest(root)).toEqual(before);
  });

  test("applies the explicit prebuilt AuthView opt-in in the aggregate Swift transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-prebuilt-auth-apply-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });
    const beforeApp = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: true,
    });
    expect(setup.unverifiedAppIdPrefixSuggestion).toEqual({
      source: "xcode-development-team",
      value: "ABCDE12345",
    });
    expect(setup.prebuiltAuthPlan?.status).toBe("ready");
    await applyIOSPlannedLocalSetup(setup, authFixtureKey);

    const source = await Bun.file(join(root, "MyApp", "ContentView.swift")).text();
    expect(source).toContain("UserButton(signedOutContent:");
    expect(source).toContain('Button("Sign up")');
    expect(source).toContain("@State private var authIsPresented = false");
    expect(source).toContain(".prefetchClerkImages()");
    expect(source).toContain(".sheet(isPresented: $authIsPresented)");
    expect(source).toContain("AuthView()");
    expect(source).not.toContain("@Environment");
    expect(source).not.toContain(".onOpenURL");
    expect(source).not.toContain("clerk.auth.events");
    expect(source).not.toContain("clerk.session?.tasks");
    expect(source).not.toContain(".alert(");
    expect(source).not.toContain("#Preview");
    expect(await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text()).not.toBe(beforeApp);

    const firstDigest = await treeDigest(root);
    const rerun = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: true,
    });
    expect(rerun.prebuiltAuthPlan?.status).toBe("satisfied");
    await applyIOSPlannedLocalSetup(rerun, authFixtureKey);
    expect(await treeDigest(root)).toEqual(firstDigest);
    expect(`${captured.out}\n${captured.err}`).not.toContain(authFixtureKey);
  });

  test("blocks an explicit prebuilt AuthView below iOS 17 before the aggregate write", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-prebuilt-auth-ios16-apply-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await Bun.write(
      projectPath,
      (await Bun.file(projectPath).text()).replaceAll(
        "IPHONEOS_DEPLOYMENT_TARGET = 17.0",
        "IPHONEOS_DEPLOYMENT_TARGET = 16.4",
      ),
    );
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
        prebuiltAuthUI: true,
      }),
    ).rejects.toThrow("require iOS 17.0 or newer");

    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, "MyApp", "ContentView.swift")).text()).not.toContain(
      "AuthView()",
    );
  });

  test("links ClerkKitUI when a custom-flow target explicitly opts into AuthView", async () => {
    const root = await createCustomFlowWithStarterContent();

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: true,
    });

    expect(setup.prebuiltAuthPlan?.status).toBe("ready");
    expect(setup.directConfigPlan).toMatchObject({
      status: "ready",
      changes: {
        configuration: "insert-initializer",
        environment: "insert",
      },
    });
    expect(setup.requiresDevelopmentKey).toBe(true);
    expect(setup.sdkInstallPlan?.products).toEqual(["ClerkKit", "ClerkKitUI"]);
    await applyIOSPlannedLocalSetup(setup, authFixtureKey);

    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toMatchObject({
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
    expect(await Bun.file(join(root, "MyApp", "ContentView.swift")).text()).toContain("AuthView()");
    const appSource = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(appSource).toContain("Clerk.configure(publishableKey:");
    expect(appSource).toContain(".environment(Clerk.shared)");
  });

  test("links ClerkKitUI when a custom-flow target accepts the AuthView prompt", async () => {
    const root = await createCustomFlowWithStarterContent();
    const confirmation = spyOn(prompts, "confirm").mockImplementation(async ({ message }) => {
      if (message.startsWith("Add ClerkKitUI's prebuilt authentication UI")) return true;
      if (message.startsWith("Enable native Sign in with Apple")) return false;
      if (message === "Apply these local iOS changes?") return true;
      throw new Error(`Unexpected confirmation: ${message}`);
    });

    try {
      const setup = await applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: false,
        agent: false,
        allowDirty: true,
      });

      expect(setup.prebuiltAuthRequested).toBe(true);
      expect(setup.directConfigPlan?.status).toBe("ready");
      expect(setup.sdkInstallPlan?.products).toEqual(["ClerkKit", "ClerkKitUI"]);
      await applyIOSPlannedLocalSetup(setup, authFixtureKey);
    } finally {
      confirmation.mockRestore();
    }

    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages.clerkKitUI).toBe("linked");
    const appSource = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(appSource).toContain("Clerk.configure(publishableKey:");
    expect(appSource).toContain(".environment(Clerk.shared)");
  });

  test("directly configures a fresh target without changing an unreferenced LocalSecrets plist", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-unused-local-secrets-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { includeKey: false, localSecrets: true });
    const localSecretsPath = join(root, "MyApp", "LocalSecrets.plist");
    const localSecretsBefore = await Bun.file(localSecretsPath).text();

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: true,
      allowDirty: false,
    });

    expect(setup.directConfigPlan).toMatchObject({
      status: "ready",
      changes: {
        configuration: "insert-initializer",
        environment: "insert",
      },
    });
    expect(setup.requiresExplicitApplication).toBe(false);
    await applyIOSPlannedLocalSetup(setup, authFixtureKey);

    const appSource = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(appSource).toContain("Clerk.configure(publishableKey:");
    expect(appSource).toContain(".environment(Clerk.shared)");
    expect(await Bun.file(localSecretsPath).text()).toBe(localSecretsBefore);
  });

  test("directly configures a fresh target without changing a stale Run-scheme key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-unused-scheme-key-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { includeKey: false });
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    const schemePath = join(schemeDirectory, "MyApp.xcscheme");
    const staleKey = `pk_test_${btoa("stale.clerk.example$")}`;
    const schemeSource = `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${staleKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`;
    await mkdir(schemeDirectory, { recursive: true });
    await Bun.write(schemePath, schemeSource);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: true,
      allowDirty: false,
    });

    expect(setup.directConfigPlan).toMatchObject({
      status: "ready",
      changes: {
        configuration: "insert-initializer",
        environment: "insert",
      },
    });
    await applyIOSPlannedLocalSetup(setup, authFixtureKey);

    const appSource = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(appSource).toContain("Clerk.configure(publishableKey:");
    expect(appSource).toContain(".environment(Clerk.shared)");
    expect(await Bun.file(schemePath).text()).toBe(schemeSource);
  });

  test("refuses a ProcessInfo compatibility path without proven SwiftUI environment injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-process-info-auth-view-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(
      publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? ""
    )
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
`,
    );
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    await Bun.write(
      join(schemeDirectory, "MyApp.xcscheme"),
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${authFixtureKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
    );
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: true,
        prebuiltAuthUI: true,
      }),
    ).rejects.toThrow("Clerk.shared is not proven in the shipping SwiftUI root environment");

    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, "MyApp", "ContentView.swift")).text()).not.toContain(
      "AuthView()",
    );
  });

  test("refuses a LocalSecrets compatibility path without proven SwiftUI environment injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-local-secrets-auth-view-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    await addStarterContentViewToFixture(root);
    const appPath = join(root, "MyApp", "MyAppApp.swift");
    const appSource = (await Bun.file(appPath).text()).replace("import ClerkKitUI\n", "").replace(
      `AuthView()
        .environment(Clerk.shared)
        .onOpenURL { url in Task { try await Clerk.shared.handle(url) } }`,
      "ContentView()",
    );
    await Bun.write(
      appPath,
      `${appSource}\nstruct UnusedClerkEnvironment: View {\n  var body: some View { Text("Unused").environment(Clerk.shared) }\n}\n`,
    );
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>${authFixtureKey}</string></dict></plist>`,
    );
    await Bun.write(join(root, ".gitignore"), "/MyApp/LocalSecrets.plist\n");
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: true,
        prebuiltAuthUI: true,
      }),
    ).rejects.toThrow("Clerk.shared is not proven in the shipping SwiftUI root environment");

    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, "MyApp", "ContentView.swift")).text()).not.toContain(
      "AuthView()",
    );
  });

  test("revalidates AuthView runtime prerequisites before committing any planned file", async () => {
    const root = await createCustomFlowWithStarterContent();
    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
      prebuiltAuthUI: true,
    });
    const before = await treeDigest(root);

    await expect(
      applyIOSPlannedLocalSetup({
        ...setup,
        directConfigPlan: undefined,
        requiresDevelopmentKey: false,
      }),
    ).rejects.toThrow("no longer proves its Clerk runtime prerequisites");

    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, "MyApp", "ContentView.swift")).text()).not.toContain(
      "AuthView()",
    );
  });

  test("creates an iOS-only entitlements file in the aggregate SDK and Swift transaction", async () => {
    const root = await createUnconfiguredFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();

    const result = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--target",
        "MyApp",
        "--app",
        "app_ios_apply",
        "--app-id-prefix",
        "LEGACY1234",
      ],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Create MyApp/MyApp.entitlements with the linked development");
    expect(output).not.toContain(authFixtureKey);
    const source = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(source).toContain("import ClerkKit");
    expect(source).toContain("Clerk.configure(publishableKey:");
    expect(source).toContain(".environment(Clerk.shared)");
    const entitlements = await Bun.file(join(root, "MyApp", "MyApp.entitlements")).text();
    expect(entitlements).toContain("webcredentials:ios-apply.clerk.example");
    expect(entitlements).not.toContain("application-identifier");
    expect(entitlements).not.toContain("com.apple.developer.applesignin");

    const archive = parsePbxProject(
      await Bun.file(join(root, "MyApp.xcodeproj", "project.pbxproj")).text(),
    ) as unknown as { objects: PbxObjects };
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      const settings = archive.objects[id]!.buildSettings as Record<string, unknown>;
      expect(settings.CODE_SIGN_ENTITLEMENTS).toBeUndefined();
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBe("MyApp/MyApp.entitlements");
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"]).toBe(
        "MyApp/MyApp.entitlements",
      );
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBe("MyApp/MyApp.mac.entitlements");
    }

    const digest = await treeDigest(root);
    const second = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--target",
        "MyApp",
        "--app",
        "app_ios_apply",
        "--app-id-prefix",
        "LEGACY1234",
      ],
      configDir,
    );
    expect(second.exitCode).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).not.toContain(authFixtureKey);
    expect(await treeDigest(root)).toEqual(digest);
  });

  test("rolls back SDK, Swift, and a newly created entitlements file together", async () => {
    const root = await createUnconfiguredFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const before = await treeDigest(root);
    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    await expect(
      applyIOSPlannedLocalSetup(setup, authFixtureKey, {
        beforePostWriteValidation: () => {
          throw new Error("injected aggregate validation failure");
        },
      }),
    ).rejects.toThrow("restored byte-for-byte");

    expect(await treeDigest(root)).toEqual(before);
    expect(await Bun.file(join(root, "MyApp", "MyApp.entitlements")).exists()).toBe(false);
  });

  test("explicitly opts into native Apple without requesting hosted Apple credentials", async () => {
    resetAppleConfiguration({
      enabled: false,
      authenticatable: true,
      client_id: "existing.web.service",
      client_secret: "HOSTED_APPLE_SECRET_MUST_NOT_ESCAPE",
    });
    const root = await createUnconfiguredFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();

    const result = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--target",
        "MyApp",
        "--app-id-prefix",
        "LEGACY1234",
        "--sign-in-with-apple",
      ],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Native Sign in with Apple enabled in Clerk");
    expect(output).not.toContain(authFixtureKey);
    expect(output).not.toContain("HOSTED_APPLE_SECRET_MUST_NOT_ESCAPE");
    const entitlements = await Bun.file(join(root, "MyApp", "MyApp.entitlements")).text();
    expect(entitlements).toContain("<key>com.apple.developer.applesignin</key>");
    expect(entitlements).toContain("<string>Default</string>");
    expect(currentAppleConnection()).toEqual({
      enabled: true,
      authenticatable: true,
      bundle_id: "com.example.MyApp",
      client_id: "existing.web.service",
      client_secret: "HOSTED_APPLE_SECRET_MUST_NOT_ESCAPE",
    });

    const digest = await treeDigest(root);
    const second = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--target",
        "MyApp",
        "--app",
        "app_ios_apply",
        "--sign-in-with-apple",
      ],
      configDir,
    );
    expect(second.exitCode).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).not.toContain(authFixtureKey);
    expect(await treeDigest(root)).toEqual(digest);
  });

  test("does not treat an existing Apple entitlement plus --yes as Clerk Apple opt-in", async () => {
    resetAppleConfiguration({ enabled: false, authenticatable: true });
    const root = await createUnconfiguredFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();

    const optedIn = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--target",
        "MyApp",
        "--app-id-prefix",
        "LEGACY1234",
        "--sign-in-with-apple",
      ],
      configDir,
    );
    expect(optedIn.exitCode).toBe(0);
    expect(currentAppleConnection()).toMatchObject({
      enabled: true,
      authenticatable: true,
    });

    // Keep the local entitlement as detection evidence while simulating a
    // Clerk connection that has not been opted into for this invocation.
    resetAppleConfiguration({ enabled: false, authenticatable: true });
    const withoutOptIn = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp", "--app", "app_ios_apply"],
      configDir,
    );

    expect(withoutOptIn.exitCode).toBe(0);
    expect(currentAppleConnection()).toEqual({
      enabled: false,
      authenticatable: true,
    });
    expect(`${withoutOptIn.stdout}\n${withoutOptIn.stderr}`).not.toContain(
      "Native Sign in with Apple enabled in Clerk",
    );
  });

  test("blocks a malformed present Apple entitlement without treating it as opt-in", async () => {
    const root = await createUnconfiguredFixture();
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    const entitlements = await Bun.file(entitlementsPath).text();
    await Bun.write(
      entitlementsPath,
      entitlements.replace(
        "</dict>",
        "<key>com.apple.developer.applesignin</key><array></array>\n</dict>",
      ),
    );
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: true,
        allowDirty: false,
      }),
    ).rejects.toThrow("Native Sign in with Apple could not be configured safely");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("uses the linked key host over an unrelated root env during aggregate setup", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    const unrelatedKey = `pk_test_${Buffer.from("unrelated-root.clerk.example$").toString(
      "base64",
    )}`;
    const existingEnv = `CLERK_PUBLISHABLE_KEY=${unrelatedKey}\n`;
    await Bun.write(join(root, ".env"), existingEnv);

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp", "--app", "app_ios_apply"],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "ClerkKit and ClerkKitUI linked to MyApp",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(authFixtureKey);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(unrelatedKey);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const target = inspection.appTargets.find((candidate) => candidate.name === "MyApp");
    expect(target?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
    expect(inspection.projects[0]?.packages[0]).toMatchObject({
      kind: "remote",
      repository: "https://github.com/clerk/clerk-ios",
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
      isClerk: true,
    });
    const source = await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text();
    expect(source).toContain("import ClerkKit");
    expect(source.match(/Clerk\.configure\(publishableKey:/g)).toHaveLength(1);
    expect(source).toContain(".environment(Clerk.shared)");
    const entitlements = await Bun.file(join(root, "MyApp", "MyApp.entitlements")).text();
    expect(entitlements).toContain("webcredentials:ios-apply.clerk.example");
    expect(entitlements).not.toContain("webcredentials:unrelated-root.clerk.example");
    expect(`${result.stdout}\n${result.stderr}`).toContain("Clerk Associated Domain added");
    expect(await Bun.file(join(root, ".env")).text()).toBe(existingEnv);
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).exists()).toBe(false);

    const afterFirstRun = await treeDigest(root);
    const second = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp", "--app", "app_ios_apply"],
      configDir,
    );
    expect(second.exitCode).toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).not.toContain(authFixtureKey);
    expect(await treeDigest(root)).toEqual(afterFirstRun);
  });

  test("adds ClerkKitUI to a source-blank target left core-only by an earlier setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-core-only-migration-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      clerkSDK: "core-only",
      complete: false,
      includeKey: false,
    });
    const configDir = await createIsolatedCLIState();

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp"],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "ClerkKit and ClerkKitUI linked to MyApp",
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toMatchObject({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
  });

  test("preserves ClerkKit-only installation for an existing custom-flow source", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Custom auth") } }
}
`,
    );

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp"],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
  });

  test("does not choose products when Swift source membership is incomplete", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Custom auth") } }
}
`,
    );
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectFile).text();
    const danglingBuildFile = "FEFEFEFEFEFEFEFEFEFEFEFE";
    await Bun.write(
      projectFile,
      project.replace(
        `files = ( ${IOS_FIXTURE_IDS.sourceBuildFile}, );`,
        `files = ( ${IOS_FIXTURE_IDS.sourceBuildFile}, ${danglingBuildFile}, );`,
      ),
    );
    const before = await treeDigest(root);

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp"],
      configDir,
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("could not be inspected completely");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("links both products only to a fresh explicitly selected second target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-second-target-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      clerkSDK: false,
      includeKey: false,
      secondTarget: true,
    });
    const configDir = await createIsolatedCLIState();

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "AdminApp", "--app-id-prefix", "ADMIN12345"],
      configDir,
    );

    expect(result.exitCode).toBe(0);
    const inspection = await inspectIOSProject(root);
    const primary = inspection.appTargets.find((target) => target.name === "MyApp");
    const selected = inspection.appTargets.find((target) => target.name === "AdminApp");
    expect(primary?.packages).toMatchObject({
      clerkKit: "absent",
      clerkKitUI: "absent",
    });
    expect(selected?.packages).toMatchObject({
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
  });

  test("validates an apparently linked graph before treating it as a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-wrong-package-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root);
    const configDir = await createIsolatedCLIState();
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const wrongPackageId = "919191919191919191919191";
    const malformed = (await Bun.file(projectFile).text())
      .replace(
        `    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
        `    ${wrongPackageId} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://example.com/not-clerk.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };\n    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
      )
      .replaceAll(`package = ${IOS_FIXTURE_IDS.clerkPackage};`, `package = ${wrongPackageId};`);
    await Bun.write(projectFile, malformed);

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp"],
      configDir,
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("verified clerk-ios reference");
    expect(await Bun.file(projectFile).text()).toBe(malformed);
  });

  test("agent mode requires explicit --yes before changing the Xcode project", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(root, ["--mode", "agent", "init", "--target", "MyApp"], configDir);

    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("requires explicit consent");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("accepts a clean project when Git canonicalizes an aliased project path", async () => {
    const root = await mkdtemp(join("/tmp", "clerk-ios-apply-alias-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, includeKey: false });
    await runCommand(root, ["git", "init"]);
    await runCommand(root, ["git", "config", "user.name", "Clerk CLI Test"]);
    await runCommand(root, ["git", "config", "user.email", "cli-test@clerk.test"]);
    await runCommand(root, ["git", "add", "."]);
    await runCommand(root, ["git", "commit", "-m", "fixture"]);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: true,
      allowDirty: false,
    });
    await applyIOSPlannedLocalSetup(setup, authFixtureKey);

    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toMatchObject({
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
  });

  test("an already-linked generated project is not source-edited", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-generated-satisfied-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { generated: "xcodegen" });
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(root, ["--mode", "agent", "init", "--target", "MyApp"], configDir);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("XcodeGen project");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("an already-linked SDK preserves a custom runtime source without prompting or writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-verification-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    await Bun.write(
      entitlementsPath,
      (await Bun.file(entitlementsPath).text()).replace(
        "webcredentials:clerk.example.test",
        "webcredentials:native.clerk.example",
      ),
    );
    const before = await treeDigest(root);
    const confirmation = spyOn(prompts, "confirm").mockResolvedValue(false);

    try {
      const result = await applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: true,
        allowDirty: false,
      });

      expect(result.requiresExplicitApplication).toBe(true);
      expect(confirmation).not.toHaveBeenCalled();
      expect(await treeDigest(root)).toEqual(before);
    } finally {
      confirmation.mockRestore();
    }
  });

  test("preserves a custom LocalSecrets source without inspecting its value", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-preflight-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
    });
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>replace-me</string></dict></plist>',
    );
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    expect(setup.requiresExplicitApplication).toBe(true);
    expect(await treeDigest(root)).toEqual(before);
  });
});
