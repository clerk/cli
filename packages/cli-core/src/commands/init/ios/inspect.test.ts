import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkspace } from "./discovery.ts";
import { inspectIOSProject } from "./inspect.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-inspect-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, options);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("inspectIOSProject", () => {
  test("inspects target settings, Clerk linkage, entitlements, and Swift setup", async () => {
    const root = await fixture({ complete: true, workspace: true });
    const inspection = await inspectIOSProject(root);

    expect(inspection.selection).toEqual({
      state: "selected",
      targetId: IOS_FIXTURE_IDS.appTarget,
      targetName: "MyApp",
      projectPath: "MyApp.xcodeproj",
    });
    expect(inspection.workspaces).toEqual([
      { path: "MyApp.xcworkspace", projectPaths: ["MyApp.xcodeproj"] },
    ]);
    expect(inspection.projects[0]?.packages[0]).toMatchObject({
      kind: "remote",
      repository: "https://github.com/clerk/clerk-ios",
      isClerk: true,
    });

    const target = inspection.appTargets[0];
    expect(target?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
    expect(target?.configurations.map((configuration) => configuration.name)).toEqual([
      "Debug",
      "Release",
    ]);
    expect(target?.configurations[0]?.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.MyApp",
    });
    expect(target?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: ["webcredentials:clerk.example.test"],
      literalAppIdentifierPrefix: "LEGACY1234",
      teamIdentifier: "ABCDE12345",
    });
    expect(target?.swift).toMatchObject({
      status: "complete",
      sourceFilesScanned: 1,
    });
    expect(target?.runtimeKeySinks).toEqual([]);
    expect(inspection.localPublishableKey).toEqual({
      found: true,
      source: ".env",
      frontendApiHost: "clerk.example.test",
      instanceType: "development",
      conflict: false,
      candidateSources: [".env"],
      invalidSources: [],
    });
    const fixtureKey = `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
    expect(JSON.stringify(inspection)).not.toContain(fixtureKey);

    const fromWorkspaceBundle = await inspectIOSProject(join(root, "MyApp.xcworkspace"));
    expect(fromWorkspaceBundle.selection).toMatchObject({
      state: "selected",
      targetName: "MyApp",
    });

    const embeddedWorkspace = join(root, "MyApp.xcodeproj", "project.xcworkspace");
    await mkdir(embeddedWorkspace, { recursive: true });
    await Bun.write(
      join(embeddedWorkspace, "contents.xcworkspacedata"),
      '<?xml version="1.0"?><Workspace version="1.0"><FileRef location="self:"></FileRef></Workspace>',
    );
    const fromEmbeddedWorkspace = await inspectIOSProject(embeddedWorkspace);
    expect(fromEmbeddedWorkspace.selection).toMatchObject({
      state: "selected",
      targetName: "MyApp",
      projectPath: "MyApp.xcodeproj",
    });
  });

  test("does not synthesize workspace markup across XML comments", async () => {
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      `<Workspace version="1.0">
        <Fi<!-- -->leRef location="group:Injected.xcodeproj"></FileRef>
        <!-- <FileRef location="group:Commented.xcodeproj"></FileRef> -->
        <FileRef location="group:MyApp.xcodeproj"></FileRef>
      </Workspace>`,
    );

    const result = await inspectWorkspace(root, workspace);

    expect(result.inspection.projectPaths).toEqual(["MyApp.xcodeproj"]);
    expect(result.localProjectPaths).toEqual([join(root, "MyApp.xcodeproj")]);
  });

  test("does not parse a workspace location token from inside another quoted attribute", async () => {
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      `<Workspace version="1.0">
        <FileRef note="location=&quot;group:Injected.xcodeproj&quot;" location="group:MyApp.xcodeproj"></FileRef>
      </Workspace>`,
    );

    const result = await inspectWorkspace(root, workspace);

    expect(result.inspection.projectPaths).toEqual(["MyApp.xcodeproj"]);
    expect(result.localProjectPaths).toEqual([join(root, "MyApp.xcodeproj")]);
  });

  test("does not guess when multiple application targets exist", async () => {
    const root = await fixture({ secondTarget: true });
    const inspection = await inspectIOSProject(root);

    expect(inspection.selection.state).toBe("ambiguous");
    expect(
      inspection.diagnostics.some((diagnostic) => diagnostic.code === "xcode.ambiguous-app-target"),
    ).toBe(true);
  });

  test("selects an explicit target by name or object ID", async () => {
    const root = await fixture({ secondTarget: true });

    const byName = await inspectIOSProject(root, { target: "AdminApp" });
    const byId = await inspectIOSProject(root, { target: IOS_FIXTURE_IDS.appTarget });

    expect(byName.selection).toMatchObject({ state: "selected", targetName: "AdminApp" });
    expect(byId.selection).toMatchObject({ state: "selected", targetName: "MyApp" });
  });

  test("reports usable target choices when an explicit target is not found", async () => {
    const root = await fixture({ secondTarget: true });

    const inspection = await inspectIOSProject(root, { target: "MissingApp" });

    expect(inspection.selection).toEqual({
      state: "not-found",
      requested: "MissingApp",
      candidates: [
        `AdminApp (${IOS_FIXTURE_IDS.secondTarget})`,
        `MyApp (${IOS_FIXTURE_IDS.appTarget})`,
      ],
    });
    expect(inspection.projects[0]?.appTargetIds).toEqual([
      IOS_FIXTURE_IDS.secondTarget,
      IOS_FIXTURE_IDS.appTarget,
    ]);
  });

  test("does not treat watchOS application products as iOS app candidates", async () => {
    const root = await fixture({ secondTarget: "watchos" });
    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets.map((target) => target.name)).toEqual(["MyApp"]);
    expect(inspection.selection).toMatchObject({ state: "selected", targetName: "MyApp" });
  });

  test("preserves conflicting configuration values instead of guessing", async () => {
    const root = await fixture({ conflictingBundle: true });
    const inspection = await inspectIOSProject(root);

    expect(
      inspection.appTargets[0]?.configurations.map((configuration) =>
        configuration.bundleIdentifier.state === "resolved"
          ? configuration.bundleIdentifier.value
          : configuration.bundleIdentifier.state,
      ),
    ).toEqual(["com.example.MyApp", "com.example.MyApp.release"]);
    expect(
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "xcode.conflicting-build-setting",
      ),
    ).toBe(true);
  });

  test("reports a setting present in only one build configuration", async () => {
    const root = await fixture({ releaseEntitlements: false });
    const inspection = await inspectIOSProject(root);

    expect(
      inspection.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "xcode.conflicting-build-setting" &&
          diagnostic.message.includes("Release=<missing>"),
      ),
    ).toBe(true);
  });

  test("resolves checked-in xcconfig includes and variables without Xcode", async () => {
    const root = await fixture({ xcconfig: true });
    const inspection = await inspectIOSProject(root);
    const configurations = inspection.appTargets[0]?.configurations;

    expect(configurations?.map((configuration) => configuration.bundleIdentifier)).toEqual([
      expect.objectContaining({ state: "resolved", value: "com.example.MyApp" }),
      expect.objectContaining({ state: "resolved", value: "com.example.MyApp" }),
    ]);
    expect(configurations?.map((configuration) => configuration.developmentTeam)).toEqual([
      expect.objectContaining({ state: "resolved", value: "ABCDE12345" }),
      expect.objectContaining({ state: "resolved", value: "ABCDE12345" }),
    ]);
  });

  test("reads a target-owned LocalSecrets.plist without exposing its key", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      found: true,
      source: "MyApp/LocalSecrets.plist",
      frontendApiHost: "native.clerk.example",
      instanceType: "production",
      conflict: false,
      candidateSources: ["MyApp/LocalSecrets.plist"],
      invalidSources: [],
    });
    expect(inspection.appTargets[0]?.runtimeKeySinks).toEqual([
      { kind: "local-secrets-plist", path: "MyApp/LocalSecrets.plist" },
    ]);
    expect(JSON.stringify(inspection)).not.toContain("pk_live_");
  });

  test("treats a direct @main literal as the selected target's runtime key without exposing it", async () => {
    const root = await fixture({ includeKey: false });
    const publishableKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${publishableKey}")
  }

  var body: some Scene {
    WindowGroup {
      Text("Hello")
        .environment(Clerk.shared)
    }
  }
}
`,
    );

    const inspection = await inspectIOSProject(root, { target: "MyApp" });

    expect(inspection.localPublishableKey).toEqual({
      found: true,
      conflict: false,
      source: "MyApp/MyAppApp.swift",
      frontendApiHost: "inline.clerk.example",
      instanceType: "development",
      candidateSources: ["MyApp/MyAppApp.swift"],
      invalidSources: [],
    });
    expect(JSON.stringify(inspection)).not.toContain(publishableKey);
  });

  test("reads an enabled publishable key from the selected target's Run scheme", async () => {
    const root = await fixture({ includeKey: false });
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const schemeKey = `pk_test_${Buffer.from("scheme.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(schemeDirectory, "MyApp.xcscheme"),
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${schemeKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toMatchObject({
      found: true,
      source: "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
      frontendApiHost: "scheme.clerk.example",
      conflict: false,
    });
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
  });

  test("ignores a workspace scheme that references a different same-named project container", async () => {
    const root = await fixture({ includeKey: false, workspace: true });
    const schemeDirectory = join(root, "MyApp.xcworkspace", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const schemeKey = `pk_test_${Buffer.from("wrong-container.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(schemeDirectory, "WrongContainer.xcscheme"),
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" ReferencedContainer="container:Other/MyApp.xcodeproj" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${schemeKey}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
    });
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
  });

  test("blocks derived advice when equally effective keys point to different instances", async () => {
    const root = await fixture({ includeKey: false });
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const firstKey = `pk_test_${Buffer.from("first.clerk.example$").toString("base64")}`;
    const secondKey = `pk_live_${Buffer.from("second.clerk.example$").toString("base64")}`;
    const scheme = (key: string) =>
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${key}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`;
    await Bun.write(join(schemeDirectory, "First.xcscheme"), scheme(firstKey));
    await Bun.write(join(schemeDirectory, "Second.xcscheme"), scheme(secondKey));

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      found: true,
      source: "MyApp.xcodeproj/xcshareddata/xcschemes/First.xcscheme",
      conflict: true,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/First.xcscheme",
        "MyApp.xcodeproj/xcshareddata/xcschemes/Second.xcscheme",
      ],
      invalidSources: [],
    });
    expect(
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "clerk.conflicting-publishable-keys",
      ),
    ).toBe(true);
    expect(JSON.stringify(inspection)).not.toContain(firstKey);
    expect(JSON.stringify(inspection)).not.toContain(secondKey);
  });

  test("does not conflict a selected-target runtime key with the CLI process environment", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const ambientKey = `pk_test_${Buffer.from("ambient.clerk.example$").toString("base64")}`;
    const previousAmbientKey = process.env.CLERK_PUBLISHABLE_KEY;
    process.env.CLERK_PUBLISHABLE_KEY = ambientKey;

    try {
      const inspection = await inspectIOSProject(root);

      expect(inspection.localPublishableKey).toMatchObject({
        found: true,
        conflict: false,
        source: "MyApp/LocalSecrets.plist",
        frontendApiHost: "native.clerk.example",
      });
      expect(inspection.localPublishableKey.candidateSources).toEqual([
        "CLERK_PUBLISHABLE_KEY environment variable",
        "MyApp/LocalSecrets.plist",
      ]);
      expect(
        inspection.diagnostics.some(
          (diagnostic) => diagnostic.code === "clerk.conflicting-publishable-keys",
        ),
      ).toBe(false);
      expect(JSON.stringify(inspection)).not.toContain(ambientKey);
    } finally {
      if (previousAmbientKey == null) delete process.env.CLERK_PUBLISHABLE_KEY;
      else process.env.CLERK_PUBLISHABLE_KEY = previousAmbientKey;
    }
  });

  test("does not fall through when the highest-precedence key is malformed", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const schemePath = join(schemeDirectory, "MyApp.xcscheme");
    await Bun.write(
      schemePath,
      `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="not-a-key" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      found: false,
      source: "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
      ],
      invalidSources: ["MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme"],
    });
  });

  test("does not treat web-framework key names as native iOS configuration", async () => {
    const root = await fixture({ includeKey: false });
    const webKey = `pk_test_${Buffer.from("web.clerk.example$").toString("base64")}`;
    await Bun.write(join(root, ".env"), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${webKey}\n`);

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
    });
  });

  test("does not follow an entitlements symlink outside the inspected root", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    const externalRoot = await mkdtemp(join(tmpdir(), "clerk-ios-external-"));
    temporaryDirectories.push(externalRoot);
    const externalEntitlements = join(externalRoot, "External.entitlements");
    await Bun.write(externalEntitlements, "<plist><dict></dict></plist>");
    await rm(join(root, "MyApp", "MyApp.entitlements"));
    await symlink(externalEntitlements, join(root, "MyApp", "MyApp.entitlements"));

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toBeUndefined();
    expect(
      inspection.diagnostics.some((diagnostic) => diagnostic.code === "xcode.external-path"),
    ).toBe(true);
  });

  test("honors synchronized-group membership exceptions and iOS platform filters", async () => {
    const root = await fixture({ complete: false });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const original = await Bun.file(projectFile).text();
    const synchronizedObjects = `
    404040404040404040404040 = { isa = PBXFileSystemSynchronizedRootGroup; exceptions = ( 414141414141414141414141, 424242424242424242424242, ); path = Synced; sourceTree = "<group>"; };
    414141414141414141414141 = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; membershipExceptions = ( "Excluded/Auth.swift", ); platformFiltersByRelativePath = { MacOnly.swift = ( macos, ); }; target = ${IOS_FIXTURE_IDS.appTarget}; };
    424242424242424242424242 = { isa = PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet; buildPhase = ${IOS_FIXTURE_IDS.sourcesPhase}; membershipExceptions = ( PhaseExcluded.swift, ); };
    `;
    await Bun.write(
      projectFile,
      original
        .replace(
          `productType = "com.apple.product-type.application";\n      packageProductDependencies`,
          `productType = "com.apple.product-type.application";\n      fileSystemSynchronizedGroups = ( 404040404040404040404040, );\n      packageProductDependencies`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
          `${synchronizedObjects}\n    ${IOS_FIXTURE_IDS.projectConfigList} = { isa = XCConfigurationList;`,
        ),
    );
    await mkdir(join(root, "Synced", "Included"), { recursive: true });
    await mkdir(join(root, "Synced", "Excluded"), { recursive: true });
    await Bun.write(
      join(root, "Synced", "Included", "Auth.swift"),
      "import ClerkKitUI\nstruct Included { let view = AuthView() }\n",
    );
    await Bun.write(
      join(root, "Synced", "Excluded", "Auth.swift"),
      "import ClerkKitUI\nstruct Excluded { let view = AuthView() }\n",
    );
    await Bun.write(
      join(root, "Synced", "PhaseExcluded.swift"),
      "import ClerkKit\nfunc excluded() { Clerk.configure(publishableKey: key) }\n",
    );
    await Bun.write(
      join(root, "Synced", "MacOnly.swift"),
      "import ClerkKit\nfunc macOnly() { Clerk.configure(publishableKey: key) }\n",
    );

    const inspection = await inspectIOSProject(root);
    const swift = inspection.appTargets[0]?.swift;

    expect(swift?.sourceFilesScanned).toBe(2);
    expect(swift?.authFlowReferences).toEqual([{ path: "Synced/Included/Auth.swift" }]);
    expect(swift?.configureCalls).toEqual([]);
  });

  test("does not use Catalyst-only classic build-file membership as native iOS evidence", async () => {
    const root = await fixture({ complete: true });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const original = await Bun.file(projectFile).text();
    await Bun.write(
      projectFile,
      original
        .replace(
          `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef`,
          `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; platformFilters = ( maccatalyst, ); fileRef`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; productRef`,
          `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; platformFilters = ( maccatalyst, ); productRef`,
        ),
    );

    const inspection = await inspectIOSProject(root);
    const target = inspection.appTargets[0];

    expect(target?.swift.sourceFilesScanned).toBe(0);
    expect(target?.swift.configureCalls).toEqual([]);
    expect(target?.packages.clerkKit).toBe("declared");
  });

  test("does not use unknown classic build-file filters as authoritative iOS evidence", async () => {
    const root = await fixture({ complete: true });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const original = await Bun.file(projectFile).text();
    await Bun.write(
      projectFile,
      original
        .replace(
          `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef`,
          `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; platformFilter = futureos; fileRef`,
        )
        .replace(
          `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; productRef`,
          `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; platformFilter = futureos; productRef`,
        ),
    );

    const inspection = await inspectIOSProject(root);
    const target = inspection.appTargets[0];

    expect(target?.swift.sourceFilesScanned).toBe(0);
    expect(target?.swift.evidenceComplete).toBe(false);
    expect(target?.packages.clerkKit).toBe("declared");
  });

  test("does not use non-iOS or unknown LocalSecrets resource membership as a native key", async () => {
    for (const platformFilter of ["maccatalyst", "futureos"]) {
      const root = await fixture({ includeKey: false, localSecrets: true });
      const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
      const original = await Bun.file(projectFile).text();
      await Bun.write(
        projectFile,
        original.replace(
          `${IOS_FIXTURE_IDS.localSecretsBuildFile} = { isa = PBXBuildFile; fileRef`,
          `${IOS_FIXTURE_IDS.localSecretsBuildFile} = { isa = PBXBuildFile; platformFilter = ${platformFilter}; fileRef`,
        ),
      );

      const inspection = await inspectIOSProject(root);

      expect(inspection.localPublishableKey).toEqual({
        found: false,
        conflict: false,
        candidateSources: [],
        invalidSources: [],
      });
    }
  });

  test("reports malformed projects as blocked evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-inspect-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "Broken.xcodeproj"));
    await Bun.write(join(root, "Broken.xcodeproj", "project.pbxproj"), "{ objects = (");

    const inspection = await inspectIOSProject(root);

    expect(inspection.selection.state).toBe("none");
    expect(
      inspection.diagnostics.some((diagnostic) => diagnostic.code === "xcode.malformed-project"),
    ).toBe(true);
  });

  test("detects generated projects and never mutates the inspected tree", async () => {
    const root = await fixture({ complete: true, generated: "xcodegen" });
    const before = await treeDigest(root);

    const inspection = await inspectIOSProject(root);

    expect(inspection.generatedProject).toBe("xcodegen");
    expect(await treeDigest(root)).toEqual(before);
  });
});
