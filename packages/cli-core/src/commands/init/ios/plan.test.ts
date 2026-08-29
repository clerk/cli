import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planIOSDirectConfig } from "./direct-config.ts";
import { planIOSAssociatedDomain } from "./associated-domain.ts";
import { inspectIOSProject } from "./inspect.ts";
import { formatIOSSetupPlan } from "./output.ts";
import { buildIOSSetupPlan } from "./plan.ts";
import { createIOSFixture } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

async function planFor(options: Parameters<typeof createIOSFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, options);
  const inspection = await inspectIOSProject(root);
  return buildIOSSetupPlan(inspection);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("buildIOSSetupPlan", () => {
  test("returns stable ordered steps while preserving a custom project key source", async () => {
    const plan = await planFor({ complete: true });

    expect(plan.steps.map((step) => step.id)).toEqual([
      "select-target",
      "install-clerk-sdk",
      "configure-publishable-key",
      "inject-clerk-environment",
      "register-native-application",
      "add-associated-domain",
      "add-authentication-flow",
      "verify-integration",
    ]);
    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")).toMatchObject({
      status: "satisfied",
      automatable: false,
    });
    expect(plan.steps.filter((step) => step.automatable)).toEqual([]);
    const configureStep = plan.steps.find((step) => step.id === "configure-publishable-key");
    expect(configureStep?.status).toBe("satisfied");
    expect(configureStep?.description).toContain("custom publishable-key source");
    expect(configureStep?.description).toContain("value is not inspected");
    const domainStep = plan.steps.find((step) => step.id === "add-associated-domain");
    expect(domainStep?.status).toBe("blocked");
    expect(domainStep?.description).toContain("valid local publishable key is needed");
    expect(plan.steps.find((step) => step.id === "register-native-application")?.status).toBe(
      "review",
    );
    expect(JSON.stringify(plan)).not.toContain("CLERK_PUBLISHABLE_KEY=");
  });

  test("classifies a LocalSecrets loader as a preserved custom key source", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const inspection = await inspectIOSProject(root);

    const plan = buildIOSSetupPlan(inspection);

    expect(inspection.appTargets[0]?.swift.configureCalls).toEqual([
      {
        inlinePublishableKey: undefined,
        path: "MyApp/MyAppApp.swift",
        publishableKeyWiring: "custom",
        startupBinding: "app-init",
      },
    ]);
    expect(inspection.localPublishableKey.state).toBe("unproven");
    expect(plan.steps.find((step) => step.id === "configure-publishable-key")?.status).toBe(
      "satisfied",
    );
  });

  test("reviews configuration when an additional configure call is not proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.swift.configureCalls.push({
      path: "MyApp/SecondarySetup.swift",
      publishableKeyWiring: "custom",
      startupBinding: "unproven",
    });

    const plan = buildIOSSetupPlan(inspection);
    const configureStep = plan.steps.find((step) => step.id === "configure-publishable-key");

    expect(configureStep).toMatchObject({ status: "review", automatable: false });
    expect(configureStep?.description).toContain("More than one Clerk.configure");
    const output = formatIOSSetupPlan(inspection, plan);
    expect(output).toContain("Publishable key: configuration needs review (value not inspected)");
    expect(output).not.toContain("found but invalid");
    expect(output).not.toContain("Publishable key: not found");
  });

  test("satisfies configuration and derives the domain from a redacted inline literal", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { includeKey: false });
    const publishableKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${publishableKey}") }
  var body: some Scene {
    WindowGroup { Text("Hello").environment(Clerk.shared) }
  }
}
`,
    );
    const inspection = await inspectIOSProject(root);
    if (inspection.selection.state !== "selected") throw new Error("fixture target not selected");
    const directConfigPlan = await planIOSDirectConfig({
      root,
      projectPath: inspection.selection.projectPath,
      targetId: inspection.selection.targetId,
    });

    const plan = buildIOSSetupPlan(inspection, { directConfigPlan });

    expect(directConfigPlan.changes?.configuration).toBe("verify-existing");
    expect(plan.steps.find((step) => step.id === "configure-publishable-key")).toMatchObject({
      status: "satisfied",
      automatable: false,
    });
    expect(plan.steps.find((step) => step.id === "add-associated-domain")?.description).toContain(
      "webcredentials:inline.clerk.example",
    );
    expect(JSON.stringify(plan)).not.toContain(publishableKey);
  });

  test("marks safe fresh direct configuration and environment injection as automatable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);
    if (inspection.selection.state !== "selected") throw new Error("fixture target not selected");
    const directConfigPlan = await planIOSDirectConfig({
      root,
      projectPath: inspection.selection.projectPath,
      targetId: inspection.selection.targetId,
    });

    const plan = buildIOSSetupPlan(inspection, { directConfigPlan });

    expect(directConfigPlan).toMatchObject({
      status: "ready",
      changes: {
        clerkKitImport: "insert",
        configuration: "insert-initializer",
        environment: "insert",
      },
    });
    expect(plan.steps.find((step) => step.id === "configure-publishable-key")).toMatchObject({
      status: "required",
      automatable: true,
    });
    expect(
      plan.steps.find((step) => step.id === "configure-publishable-key")?.description,
    ).toContain("directly");
    expect(plan.steps.find((step) => step.id === "inject-clerk-environment")).toMatchObject({
      status: "required",
      automatable: true,
    });
    expect(JSON.stringify(plan)).not.toContain("pk_test_");
  });

  test("does not satisfy root environment setup from an unused same-file helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-root-environment-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
       import SwiftUI
       @main struct MyApp: App {
         var body: some Scene { WindowGroup { ContentView() } }
       }
       struct UnusedHelper: View {
         var body: some View { Text("Unused").environment(Clerk.shared) }
       }`,
    );

    const inspection = await inspectIOSProject(root);
    const plan = buildIOSSetupPlan(inspection);

    expect(inspection.appTargets[0]?.swift.environmentInjections).toEqual([
      { path: "MyApp/MyAppApp.swift" },
    ]);
    expect(inspection.appTargets[0]?.swift.rootEnvironmentInjections).toEqual([]);
    expect(plan.steps.find((step) => step.id === "inject-clerk-environment")).toMatchObject({
      status: "review",
      automatable: false,
    });
    expect(
      plan.steps.find((step) => step.id === "inject-clerk-environment")?.description,
    ).toContain("not proven on the shipping WindowGroup root");
  });

  test("does not satisfy environment setup from an invalid EnvironmentValues overload", async () => {
    for (const keyPath of ["\\.self", ".self"]) {
      const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-root-environment-"));
      temporaryDirectories.push(root);
      await createIOSFixture(root, { complete: true });
      await Bun.write(
        join(root, "MyApp", "MyAppApp.swift"),
        `import ClerkKit
         import ClerkKitUI
         import SwiftUI
         @main struct MyApp: App {
           var body: some Scene {
             WindowGroup { AuthView().environment(${keyPath}, Clerk.shared) }
           }
         }`,
      );

      const inspection = await inspectIOSProject(root);
      const plan = buildIOSSetupPlan(inspection);

      expect(inspection.appTargets[0]?.swift.environmentInjections).toEqual([]);
      expect(inspection.appTargets[0]?.swift.rootEnvironmentInjections).toEqual([]);
      expect(plan.steps.find((step) => step.id === "inject-clerk-environment")).toMatchObject({
        status: "required",
        automatable: false,
      });
    }
  });

  test("advertises a proven prebuilt AuthView scaffold without selecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-prebuilt-auth-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);

    const plan = buildIOSSetupPlan(inspection, {
      prebuiltAuthPlan: {
        status: "ready",
        sourcePath: "MyApp/ContentView.swift",
        actions: ["Add ClerkKitUI's prebuilt AuthView flow."],
        blockers: [],
      },
    });

    expect(plan.steps.find((step) => step.id === "add-authentication-flow")).toMatchObject({
      status: "required",
      automatable: true,
    });
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.description).toContain(
      "--prebuilt-auth-ui",
    );
  });

  test("uses the documented AuthView sheet when prebuilt authentication is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-selected-prebuilt-auth-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);

    const plan = buildIOSSetupPlan(inspection, {
      prebuiltAuthPlan: {
        status: "ready",
        sourcePath: "MyApp/ContentView.swift",
        actions: ["Add ClerkKitUI's prebuilt AuthView flow."],
        blockers: [],
      },
      prebuiltAuthSelected: true,
    });

    expect(plan.steps.find((step) => step.id === "add-authentication-flow")).toMatchObject({
      status: "required",
      automatable: true,
    });
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.description).toContain(
      "network-free local plan",
    );
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.description).toContain(
      "only if Apple is enabled",
    );
  });

  test("treats a custom email-link implementation as an existing authentication flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-magic-link-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const appPath = join(root, "MyApp", "MyAppApp.swift");
    await Bun.write(
      appPath,
      `import ClerkKit
       import SwiftUI
       @main struct MyApp: App {
         var body: some Scene {
           WindowGroup {
             ContentView()
               .environment(Clerk.shared)
           }
         }
       }
       func send(_ signIn: SignIn) async throws { try await signIn.sendEmailLink() }`,
    );

    const plan = buildIOSSetupPlan(await inspectIOSProject(root));
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")).toMatchObject({
      status: "satisfied",
      automatable: false,
    });
  });

  test("blocks a selected AuthView scaffold when the SDK compatibility proof fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-old-prebuilt-sdk-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);
    const message = "ClerkKitUI's documented native components require clerk-ios 1.0.0 or newer.";

    const plan = buildIOSSetupPlan(inspection, {
      sdkInstallPlan: {
        status: "blocked",
        blockers: [{ code: "incompatible-sdk", message }],
      },
      prebuiltAuthPlan: {
        status: "ready",
        sourcePath: "MyApp/ContentView.swift",
        actions: ["Add ClerkKitUI's prebuilt AuthView flow."],
        blockers: [],
      },
      prebuiltAuthSelected: true,
    });

    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")).toMatchObject({
      status: "blocked",
      automatable: false,
    });
    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")?.description).toContain(
      message,
    );
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")).toMatchObject({
      status: "blocked",
      automatable: false,
    });
  });

  test("blocks an explicitly requested scaffold over a partial existing auth flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-partial-prebuilt-auth-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.swift.authFlowReferences = [{ path: "MyApp/ContentView.swift" }];

    const plan = buildIOSSetupPlan(inspection, {
      prebuiltAuthPlan: {
        status: "blocked",
        sourcePath: "MyApp/ContentView.swift",
        actions: [],
        blockers: [
          {
            code: "existing-auth-integration",
            message: "An existing or partial authentication flow must be reviewed manually.",
          },
        ],
      },
      prebuiltAuthSelected: true,
    });

    expect(plan.steps.find((step) => step.id === "add-authentication-flow")).toMatchObject({
      status: "blocked",
      automatable: false,
    });
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.description).toContain(
      "partial authentication flow",
    );
  });

  test("maps every native Apple entitlement plan state into the ordered setup plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-native-apple-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, includeKey: false });
    const inspection = await inspectIOSProject(root);

    for (const fixture of [
      {
        status: "ready" as const,
        actions: ["Add the Apple entitlement."],
        blockers: [],
        expectedStatus: "required",
        automatable: true,
        text: "exact Default value",
      },
      {
        status: "satisfied" as const,
        actions: [],
        blockers: [],
        expectedStatus: "satisfied",
        automatable: false,
        text: "exact native Sign in with Apple entitlement",
      },
      {
        status: "blocked" as const,
        actions: [],
        blockers: [{ code: "unsupported-entitlements" as const, message: "Review this file." }],
        expectedStatus: "blocked",
        automatable: false,
        text: "Review this file.",
      },
    ]) {
      const plan = buildIOSSetupPlan(inspection, { appleEntitlementPlan: fixture });
      const stepIndex = plan.steps.findIndex((step) => step.id === "enable-native-apple");
      const domainIndex = plan.steps.findIndex((step) => step.id === "add-associated-domain");
      const appleStep = plan.steps[stepIndex];

      expect(stepIndex).toBeGreaterThan(-1);
      expect(stepIndex).toBeLessThan(domainIndex);
      expect(appleStep).toMatchObject({
        status: fixture.expectedStatus,
        automatable: fixture.automatable,
      });
      expect(appleStep?.description).toContain(fixture.text);
    }
  });

  test("surfaces strict Associated Domains blockers instead of asking for a local key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: false,
      includeKey: false,
      releaseEntitlements: false,
    });
    const inspection = await inspectIOSProject(root);
    if (inspection.selection.state !== "selected") throw new Error("fixture target not selected");
    const directConfigPlan = await planIOSDirectConfig({
      root,
      projectPath: inspection.selection.projectPath,
      targetId: inspection.selection.targetId,
    });
    const associatedDomainPlan = await planIOSAssociatedDomain({
      root,
      projectPath: inspection.selection.projectPath,
      targetId: inspection.selection.targetId,
      deferToPublishableKey: true,
    });

    const plan = buildIOSSetupPlan(inspection, { directConfigPlan, associatedDomainPlan });
    const domain = plan.steps.find((step) => step.id === "add-associated-domain");

    expect(associatedDomainPlan.status).toBe("blocked");
    expect(domain).toMatchObject({ status: "review", automatable: false });
    expect(domain?.description).toContain(
      "Some selected-target configurations have entitlements while others do not",
    );
    expect(domain?.description).not.toContain("valid local publishable key is needed");
  });

  test("renders strict direct-config blockers as actionable blocked steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: false,
      includeKey: false,
      generated: "xcodegen",
    });
    const inspection = await inspectIOSProject(root);
    if (inspection.selection.state !== "selected") throw new Error("fixture target not selected");
    const directConfigPlan = await planIOSDirectConfig({
      root,
      projectPath: inspection.selection.projectPath,
      targetId: inspection.selection.targetId,
    });

    const plan = buildIOSSetupPlan(inspection, { directConfigPlan });

    expect(directConfigPlan).toMatchObject({ status: "blocked" });
    expect(directConfigPlan.blockers.map((blocker) => blocker.code)).toContain("generated-project");
    const configureStep = plan.steps.find((step) => step.id === "configure-publishable-key");
    expect(configureStep).toMatchObject({ status: "blocked", automatable: false });
    expect(configureStep?.description).toContain("XcodeGen");
    expect(plan.steps.find((step) => step.id === "inject-clerk-environment")).toMatchObject({
      status: "blocked",
      automatable: false,
    });
  });

  test("does not satisfy a custom configure call outside app startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const appPath = join(root, "MyApp", "MyAppApp.swift");
    const source = await Bun.file(appPath).text();
    await Bun.write(
      appPath,
      source.replace(
        'init() { Clerk.configure(publishableKey: QuickstartLocalSecrets.load().publishableKey ?? "") }',
        `init() {}
  func unusedConfigureHelper() {
    Clerk.configure(publishableKey: QuickstartLocalSecrets.load().publishableKey ?? "")
  }`,
      ),
    );
    const inspection = await inspectIOSProject(root);
    const plan = buildIOSSetupPlan(inspection);

    expect(inspection.appTargets[0]?.swift.configureCalls[0]).toMatchObject({
      publishableKeyWiring: "custom",
      startupBinding: "unproven",
    });
    expect(plan.steps.find((step) => step.id === "configure-publishable-key")).toMatchObject({
      status: "review",
      automatable: false,
    });
  });

  test("classifies ProcessInfo wiring as a preserved custom key source", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const inspection = await inspectIOSProject(root);
    if (inspection.selection.state !== "selected") throw new Error("fixture target not selected");
    inspection.appTargets[0]!.swift.configureCalls = [
      {
        path: "MyApp/MyAppApp.swift",
        publishableKeyWiring: "custom",
        startupBinding: "app-init",
      },
    ];

    const plan = buildIOSSetupPlan(inspection);

    expect(plan.steps.find((step) => step.id === "configure-publishable-key")?.status).toBe(
      "satisfied",
    );
    expect(inspection.localPublishableKey.state).toBe("unproven");
  });

  test("preserves an arbitrary named key loader without interpreting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
       import SwiftUI
       enum LocalSecrets { static let key = "" }
       @main struct MyApp: App {
         init() { Clerk.configure(publishableKey: LocalSecrets.key) }
         var body: some Scene { WindowGroup { Text("Hello") } }
       }`,
    );
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>not-a-key</string></dict></plist>',
    );

    const plan = buildIOSSetupPlan(await inspectIOSProject(root));

    expect(plan.steps.find((step) => step.id === "configure-publishable-key")).toMatchObject({
      status: "satisfied",
      automatable: false,
    });
  });

  test("reports genuinely missing Swift setup as required", async () => {
    const plan = await planFor({ complete: false });

    expect(plan.steps.find((step) => step.id === "configure-publishable-key")?.status).toBe(
      "required",
    );
    expect(plan.steps.find((step) => step.id === "inject-clerk-environment")?.status).toBe(
      "required",
    );
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.status).toBe(
      "required",
    );
  });

  test("plans ClerkKitUI by default for an untouched target", async () => {
    const plan = await planFor({ clerkSDK: false, complete: false, includeKey: false });
    const sdkStep = plan.steps.find((step) => step.id === "install-clerk-sdk");

    expect(sdkStep).toMatchObject({ status: "required", automatable: true });
    expect(sdkStep?.description).toContain("ClerkKit and ClerkKitUI");
    expect(sdkStep?.description).toContain("prebuilt AuthView");
  });

  test("plans ClerkKitUI for a source-blank core-only graph from an earlier setup", async () => {
    const plan = await planFor({ clerkSDK: "core-only", complete: false, includeKey: false });
    const sdkStep = plan.steps.find((step) => step.id === "install-clerk-sdk");

    expect(sdkStep).toMatchObject({ status: "required", automatable: true });
    expect(sdkStep?.description).toContain("already has ClerkKit");
    expect(sdkStep?.description).toContain("Link ClerkKitUI");
  });

  test("plans only ClerkKit when existing source shows custom-flow intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { clerkSDK: false, complete: false, includeKey: false });
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

    const inspection = await inspectIOSProject(root);
    const plan = buildIOSSetupPlan(inspection);
    const sdkStep = plan.steps.find((step) => step.id === "install-clerk-sdk");

    expect(sdkStep).toMatchObject({ status: "required", automatable: true });
    expect(sdkStep?.description).toContain("custom-flow intent");
    expect(sdkStep?.description).toContain("ClerkKitUI is not required");
    const authStep = plan.steps.find((step) => step.id === "add-authentication-flow");
    expect(authStep?.description).toContain("custom ClerkKit");
    expect(authStep?.description).not.toContain("ClerkKitUI");
  });

  test("requires ClerkKitUI when selected-target source imports its prebuilt UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.packages.clerkKitUI = "absent";

    const plan = buildIOSSetupPlan(inspection);
    const sdkStep = plan.steps.find((step) => step.id === "install-clerk-sdk");

    expect(sdkStep).toMatchObject({ status: "required", automatable: true });
    const output = formatIOSSetupPlan(inspection, plan);
    expect(output).toContain("`clerk init` can apply this step.");
    expect(output.match(/`clerk init` can apply this step\./g)).toHaveLength(1);
  });

  test("repairs a declared but unlinked ClerkKitUI product without source imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.packages.clerkKitUI = "declared";

    const plan = buildIOSSetupPlan(inspection);
    const sdkStep = plan.steps.find((step) => step.id === "install-clerk-sdk");

    expect(sdkStep).toMatchObject({ status: "required", automatable: true });
    expect(sdkStep?.description).toContain("declared");
    expect(sdkStep?.description).toContain("not linked");
  });

  test("does not mark generated-project SDK installation as automatable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, generated: "xcodegen" });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.packages.clerkKitUI = "absent";

    const plan = buildIOSSetupPlan(inspection);

    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")).toMatchObject({
      status: "required",
      automatable: false,
    });
  });

  test("does not mark unattributed SDK installation as automatable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.packages.package = "unattributed";
    inspection.appTargets[0]!.packages.clerkKitUI = "absent";

    const plan = buildIOSSetupPlan(inspection);

    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")).toMatchObject({
      status: "required",
      automatable: false,
    });
  });

  test("reviews linked Clerk products when their package reference is unattributed", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.packages.package = "unattributed";

    const plan = buildIOSSetupPlan(inspection);
    const step = plan.steps.find((candidate) => candidate.id === "install-clerk-sdk");

    expect(step?.status).toBe("review");
    expect(step?.description).toContain("could not be verified as clerk-ios");
  });

  test("treats missing Swift evidence as review when source membership is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: false, clerkSDK: false });
    const inspection = await inspectIOSProject(root);
    inspection.appTargets[0]!.swift.evidenceComplete = false;

    const plan = buildIOSSetupPlan(inspection);

    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")).toMatchObject({
      status: "review",
      automatable: false,
    });
    expect(plan.steps.find((step) => step.id === "install-clerk-sdk")?.description).toContain(
      "cannot safely choose",
    );
    expect(plan.steps.find((step) => step.id === "configure-publishable-key")?.status).toBe(
      "review",
    );
    expect(plan.steps.find((step) => step.id === "inject-clerk-environment")?.status).toBe(
      "review",
    );
    expect(plan.steps.find((step) => step.id === "add-authentication-flow")?.status).toBe("review");
  });

  test("preserves an existing custom configure call without validating its value", async () => {
    const plan = await planFor({ complete: true, includeKey: false });

    expect(plan.steps.find((step) => step.id === "configure-publishable-key")?.status).toBe(
      "satisfied",
    );
  });

  test("requires the bare domain when only Apple's developer-mode suffix is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false });
    const key = `pk_test_${Buffer.from("native.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI
@main struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${key}") }
  var body: some Scene { WindowGroup { Text("Hello").environment(Clerk.shared) } }
}`,
    );
    const inspection = await inspectIOSProject(root);
    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = [
        "webcredentials:native.clerk.example?mode=developer",
      ];
    }

    const plan = buildIOSSetupPlan(inspection);

    expect(plan.steps.find((step) => step.id === "add-associated-domain")?.status).toBe("required");
  });

  test("matches only the associated-domain hostname case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false });
    const key = `pk_test_${Buffer.from("native.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI
@main struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${key}") }
  var body: some Scene { WindowGroup { Text("Hello").environment(Clerk.shared) } }
}`,
    );
    const inspection = await inspectIOSProject(root);

    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = ["webcredentials:NATIVE.CLERK.EXAMPLE"];
    }
    expect(
      buildIOSSetupPlan(inspection).steps.find((step) => step.id === "add-associated-domain"),
    ).toMatchObject({ status: "satisfied" });

    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = ["WEBCREDENTIALS:native.clerk.example"];
    }
    expect(
      buildIOSSetupPlan(inspection).steps.find((step) => step.id === "add-associated-domain"),
    ).toMatchObject({ status: "required" });
  });

  test("blocks all dependent steps when target selection is ambiguous", async () => {
    const plan = await planFor({ secondTarget: true });

    expect(plan.steps[0]?.status).toBe("blocked");
    expect(plan.steps.slice(1).every((step) => step.status === "blocked")).toBe(true);
  });

  test("includes usable choices when the requested target is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { secondTarget: true });
    const inspection = await inspectIOSProject(root, { target: "MissingApp" });

    const plan = buildIOSSetupPlan(inspection);

    const selectStep = plan.steps.find((step) => step.id === "select-target");
    expect(selectStep?.status).toBe("blocked");
    expect(selectStep?.description).toContain("AdminApp");
    expect(selectStep?.description).toContain("MyApp");
  });

  test("is deterministic for identical inspection input", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-plan-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true });
    const inspection = await inspectIOSProject(root);

    expect(buildIOSSetupPlan(inspection)).toEqual(buildIOSSetupPlan(inspection));
  });
});
