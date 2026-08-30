import { afterEach, describe, expect, test } from "bun:test";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import {
  applyIOSSDKInstall,
  DEFAULT_CLERK_IOS_MINIMUM_VERSION,
  planIOSSDKInstall,
  PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION,
  prepareIOSSDKInstallMutation,
  type IOSSDKInstallBlockerCode,
  validateIOSSDKInstallPostcondition,
} from "./install-sdk.ts";
import { applyIOSExistingFileTransaction } from "./file-transaction.ts";
import { type PbxObject, type PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

interface MutableGraph {
  project: ReturnType<typeof parsePbxProject>;
  objects: PbxObjects;
  root: PbxObject;
  target: PbxObject;
  frameworks: PbxObject;
}

async function temporaryRoot(prefix = "clerk-ios-install-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await temporaryRoot();
  await createIOSFixture(root, options);
  return root;
}

async function writePackageResolution(root: string, version: string): Promise<void> {
  const directory = join(root, "MyApp.xcodeproj", "project.xcworkspace", "xcshareddata", "swiftpm");
  await mkdir(directory, { recursive: true });
  await Bun.write(
    join(directory, "Package.resolved"),
    JSON.stringify({
      pins: [
        {
          identity: "clerk-ios",
          kind: "remoteSourceControl",
          location: "https://github.com/clerk/clerk-ios",
          state: { revision: "a".repeat(40), version },
        },
      ],
      version: 3,
    }),
  );
}

async function writeLocalClerkPackageWithExcludedAuthAPIDecoys(root: string): Promise<void> {
  const packageRoot = join(root, "LocalClerk");
  const sources: Record<string, string> = {
    "Sources/ClerkKit/Core/Auth.swift":
      "public struct Auth { public var events: AsyncStream<AuthEvent> { fatalError() } }\n",
    "Sources/ClerkKit/Core/Clerk.swift":
      "public struct Clerk { public func handle(_ url: URL) async throws -> Bool { true } }\n",
    "Sources/ClerkKit/Domains/Auth/Session/Session.swift":
      "public struct Session { public var tasks: [Task]? }\n",
    "Sources/ClerkKit/Events/AuthEvent.swift":
      "public enum AuthEvent { case signInNeedsContinuation; case signUpNeedsContinuation }\n",
    "Sources/ClerkKit/Mocks/Clerk+Preview.swift":
      "extension Clerk { public static func preview(preview: ((PreviewBuilder) -> Void)? = nil) -> Clerk { fatalError() } }\n",
    "Sources/ClerkKitUI/Components/Auth/AuthView.swift":
      "public struct AuthView: View { public init(mode: Mode = .signInOrUp, isDismissible: Bool = true) {} }\n",
    "Sources/ClerkKitUI/Components/UserButton/UserButton.swift":
      "public struct UserButton<Content> { public init(@ViewBuilder signedOutContent: () -> Content) {} }\n",
    "Sources/ClerkKit/Compiled.swift": "public struct CompiledClerkKit {}\n",
    "Sources/ClerkKitUI/Compiled.swift": "public struct CompiledClerkKitUI {}\n",
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const path = join(packageRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, source);
  }
  await Bun.write(
    join(packageRoot, "Package.swift"),
    `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Clerk",
  products: [
    .library(name: "ClerkKit", targets: ["ClerkKit"]),
    .library(name: "ClerkKitUI", targets: ["ClerkKitUI"]),
  ],
  targets: [
    .target(name: "ClerkKit", path: "Sources/ClerkKit", sources: ["Compiled.swift"]),
    .target(name: "ClerkKitUI", path: "Sources/ClerkKitUI", sources: ["Compiled.swift"]),
  ]
)
`,
  );
}

function pbxprojPath(root: string): string {
  return join(root, "MyApp.xcodeproj", "project.pbxproj");
}

function mutableGraph(project: ReturnType<typeof parsePbxProject>): MutableGraph {
  const archive = project as unknown as { rootObject: string; objects: PbxObjects };
  return {
    project,
    objects: archive.objects,
    root: archive.objects[archive.rootObject]!,
    target: archive.objects[IOS_FIXTURE_IDS.appTarget]!,
    frameworks: archive.objects[IOS_FIXTURE_IDS.frameworksPhase]!,
  };
}

async function transformProject(
  root: string,
  mutate: (graph: MutableGraph) => void,
): Promise<void> {
  const path = pbxprojPath(root);
  const graph = mutableGraph(parsePbxProject(await readFile(path, "utf8")));
  mutate(graph);
  await Bun.write(path, buildPbxProject(graph.project));
}

function removeClerkSDK(graph: MutableGraph): void {
  graph.root.packageReferences = [];
  removeClerkProductLinks(graph);
  delete graph.objects[IOS_FIXTURE_IDS.clerkPackage];
}

function removeClerkProductLinks(graph: MutableGraph): void {
  graph.target.packageProductDependencies = [];
  graph.frameworks.files = [];
  for (const id of [
    IOS_FIXTURE_IDS.clerkKit,
    IOS_FIXTURE_IDS.clerkKitUI,
    IOS_FIXTURE_IDS.clerkKitBuildFile,
    IOS_FIXTURE_IDS.clerkKitUIBuildFile,
  ]) {
    delete graph.objects[id];
  }
}

function installOptions(root: string, includeClerkKitUI = false) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
    includeClerkKitUI,
  };
}

function targetArraySnapshot(objects: PbxObjects, targetId: string): string {
  const target = objects[targetId]!;
  const buildPhases = Array.isArray(target.buildPhases)
    ? target.buildPhases.filter((item): item is string => typeof item === "string")
    : [];
  return JSON.stringify({
    buildPhases: target.buildPhases,
    buildRules: target.buildRules,
    dependencies: target.dependencies,
    packageProductDependencies: target.packageProductDependencies,
    phaseFiles: Object.fromEntries(
      buildPhases.map((phaseId) => [phaseId, objects[phaseId]?.files]),
    ),
  });
}

function installedObjectIds(root: string): Promise<{
  packageId: string;
  productId: string;
  buildFileId: string;
}> {
  return readFile(pbxprojPath(root), "utf8").then((source) => {
    const graph = mutableGraph(parsePbxProject(source));
    const packageEntry = Object.entries(graph.objects).find(
      ([, object]) =>
        object.isa === "XCRemoteSwiftPackageReference" &&
        String(object.repositoryURL).includes("clerk/clerk-ios"),
    );
    const productEntry = Object.entries(graph.objects).find(
      ([, object]) =>
        object.isa === "XCSwiftPackageProductDependency" && object.productName === "ClerkKit",
    );
    const buildFileEntry = Object.entries(graph.objects).find(
      ([, object]) => object.isa === "PBXBuildFile" && object.productRef === productEntry?.[0],
    );
    if (!packageEntry || !productEntry || !buildFileEntry) {
      throw new Error("Installed Clerk graph is incomplete.");
    }
    return {
      packageId: packageEntry[0],
      productId: productEntry[0],
      buildFileId: buildFileEntry[0],
    };
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS Clerk SDK installer", () => {
  test("returns satisfied without serializing or changing a configured project", async () => {
    const root = await fixture();
    const before = await readFile(pbxprojPath(root));

    const plan = await planIOSSDKInstall(installOptions(root, true));
    expect(plan).toMatchObject({
      status: "satisfied",
      minimumVersion: DEFAULT_CLERK_IOS_MINIMUM_VERSION,
      products: ["ClerkKit", "ClerkKitUI"],
      actions: [],
      blockers: [],
    });
    expect((await applyIOSSDKInstall(plan)).status).toBe("satisfied");
    expect(await readFile(pbxprojPath(root))).toEqual(before);
  });

  test("installs ClerkKit with stable IDs, preserves mode, and is byte-idempotent", async () => {
    const firstRoot = await fixture();
    const secondRoot = await fixture();
    await transformProject(firstRoot, removeClerkSDK);
    await transformProject(secondRoot, removeClerkSDK);
    await chmod(pbxprojPath(firstRoot), 0o640);

    const firstPlan = await planIOSSDKInstall(installOptions(firstRoot));
    const secondPlan = await planIOSSDKInstall(installOptions(secondRoot));
    expect(firstPlan.status).toBe("ready");
    expect(secondPlan.status).toBe("ready");
    expect(firstPlan.actions).toEqual(secondPlan.actions);
    expect((await applyIOSSDKInstall(firstPlan)).status).toBe("applied");
    expect((await applyIOSSDKInstall(secondPlan)).status).toBe("applied");

    const firstIds = await installedObjectIds(firstRoot);
    expect(firstIds).toEqual(await installedObjectIds(secondRoot));
    expect(Object.values(firstIds).every((id) => /^[A-F0-9]{24}$/.test(id))).toBe(true);
    expect((await stat(pbxprojPath(firstRoot))).mode & 0o777).toBe(0o640);

    const inspection = await inspectIOSProject(firstRoot, {
      target: IOS_FIXTURE_IDS.appTarget,
    });
    expect(inspection.appTargets[0]?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
    expect(inspection.projects[0]?.packages[0]).toMatchObject({
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
    });

    const afterFirstApply = await readFile(pbxprojPath(firstRoot));
    const satisfied = await planIOSSDKInstall(installOptions(firstRoot));
    expect(satisfied.status).toBe("satisfied");
    expect((await applyIOSSDKInstall(satisfied)).status).toBe("satisfied");
    expect(await readFile(pbxprojPath(firstRoot))).toEqual(afterFirstApply);
  });

  test("uses the modern ClerkKitUI minimum for a new remote package", async () => {
    const root = await fixture();
    await transformProject(root, removeClerkSDK);

    const plan = await planIOSSDKInstall({
      ...installOptions(root, true),
      requirePrebuiltAuthCompatibility: true,
    });

    expect(plan).toMatchObject({
      status: "ready",
      minimumVersion: PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION,
      requirePrebuiltAuthCompatibility: true,
    });
    expect(plan.actions[0]).toContain(PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION);
    expect((await applyIOSSDKInstall(plan)).status).toBe("applied");
    const installedPackage = (await inspectIOSProject(root)).projects[0]?.packages[0];
    expect(installedPackage?.kind).toBe("remote");
    if (installedPackage?.kind !== "remote") throw new Error("Expected a remote Clerk package.");
    expect(installedPackage.requirement).toMatchObject({
      kind: "upToNextMajorVersion",
      minimumVersion: PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION,
    });
  });

  test("raises an explicitly older requested version to the modern product floor", async () => {
    const root = await fixture();
    await transformProject(root, removeClerkSDK);

    const plan = await planIOSSDKInstall({
      ...installOptions(root),
      minimumVersion: "0.70.0",
    });

    expect(plan.minimumVersion).toBe(DEFAULT_CLERK_IOS_MINIMUM_VERSION);
    expect(plan.minimumVersion).not.toBe("0.70.0");
  });

  test("keeps the AuthView compatibility floor layered over the modern product floor", async () => {
    const root = await fixture();
    await transformProject(root, removeClerkSDK);

    const plan = await planIOSSDKInstall({
      ...installOptions(root, true),
      minimumVersion: "0.70.0",
      requirePrebuiltAuthCompatibility: true,
    });

    expect(plan.minimumVersion).toBe(PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION);
    expect(plan.requirePrebuiltAuthCompatibility).toBe(true);
  });

  test("blocks old remote constraints before adding modern ClerkKit products", async () => {
    for (const includeClerkKitUI of [false, true]) {
      const root = await fixture();
      await transformProject(root, (graph) => {
        removeClerkProductLinks(graph);
        graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.requirement = {
          kind: "versionRange",
          minimumVersion: "0.70.0",
          maximumVersion: "1.0.0",
        };
      });
      const before = await treeDigest(root);

      const plan = await planIOSSDKInstall(installOptions(root, includeClerkKitUI));

      expect(plan.status).toBe("blocked");
      expect(plan.actions).toEqual([]);
      expect(plan.blockers[0]?.code).toBe("incompatible-sdk");
      expect(plan.blockers[0]?.message).toContain(DEFAULT_CLERK_IOS_MINIMUM_VERSION);
      expect((await applyIOSSDKInstall(plan)).status).toBe("blocked");
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("rejects a package constraint downgraded after a modern plan", async () => {
    const root = await fixture({ clerkSDK: "core-only" });
    const plan = await planIOSSDKInstall(installOptions(root));
    expect(plan.status).toBe("satisfied");
    expect(await validateIOSSDKInstallPostcondition(plan)).toBe(true);

    await transformProject(root, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.requirement = {
        kind: "exactVersion",
        version: "0.70.0",
      };
    });

    expect(await validateIOSSDKInstallPostcondition(plan)).toBe(false);
  });

  test("requires a compatible resolved pin when a remote range permits older SDKs", async () => {
    const oldRoot = await fixture();
    await transformProject(oldRoot, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.requirement = {
        kind: "versionRange",
        minimumVersion: "0.70.0",
        maximumVersion: "2.0.0",
      };
    });
    await writePackageResolution(oldRoot, "0.70.0");
    const oldPlan = await planIOSSDKInstall(installOptions(oldRoot, true));
    expect(oldPlan.status).toBe("blocked");
    expect(oldPlan.blockers[0]?.code).toBe("incompatible-sdk");

    const compatibleRoot = await fixture();
    await transformProject(compatibleRoot, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.requirement = {
        kind: "versionRange",
        minimumVersion: "0.70.0",
        maximumVersion: "2.0.0",
      };
    });
    await writePackageResolution(compatibleRoot, PREBUILT_AUTH_CLERK_IOS_MINIMUM_VERSION);
    const compatiblePlan = await planIOSSDKInstall(installOptions(compatibleRoot, true));
    expect(compatiblePlan.status).toBe("satisfied");
    expect(await validateIOSSDKInstallPostcondition(compatiblePlan)).toBe(true);
  });

  test("does not trust API decoys excluded from a local package's compiled targets", async () => {
    const root = await fixture();
    await writeLocalClerkPackageWithExcludedAuthAPIDecoys(root);
    await transformProject(root, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage] = {
        isa: "XCLocalSwiftPackageReference",
        relativePath: "LocalClerk",
      };
    });

    const plan = await planIOSSDKInstall({
      ...installOptions(root, true),
      requirePrebuiltAuthCompatibility: true,
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        code: "incompatible-sdk",
        message: expect.stringContaining("compiled target membership cannot be proven"),
      }),
    ]);
  });

  test("prepares a non-serializable internal SDK mutation for a combined transaction", async () => {
    const root = await fixture();
    await transformProject(root, removeClerkSDK);
    const before = await readFile(pbxprojPath(root));
    const plan = await planIOSSDKInstall(installOptions(root, true));

    const prepared = await prepareIOSSDKInstallMutation(plan);

    expect(prepared.status).toBe("ready");
    expect(await readFile(pbxprojPath(root))).toEqual(before);
    if (prepared.status !== "ready") throw new Error("Expected a prepared SDK mutation.");
    expect(prepared.mutation.boundary.rootPath).toBe(root);
    expect(await validateIOSSDKInstallPostcondition(prepared.plan)).toBe(false);
    expect(prepared.mutation.path).toBe(pbxprojPath(root));
    expect(Object.getOwnPropertyDescriptor(prepared, "mutation")).toEqual({
      value: prepared.mutation,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const serializedPlan = JSON.stringify(prepared.plan);
    const serializedPrepared = JSON.stringify(prepared);
    expect(serializedPrepared).toBe(`{"status":"ready","plan":${serializedPlan}}`);
    expect(serializedPrepared).not.toContain("mutation");
    expect(serializedPrepared).not.toContain("originalBytes");
    expect(serializedPrepared).not.toContain("candidateBytes");
    expect(serializedPrepared).not.toContain("originalHash");
    expect(serializedPrepared).not.toContain("candidateHash");
    expect(serializedPrepared).not.toContain("boundary");

    const result = await applyIOSExistingFileTransaction(
      [prepared.mutation],
      [() => validateIOSSDKInstallPostcondition(prepared.plan)],
    );
    expect(result.status).toBe("applied");
    expect(await validateIOSSDKInstallPostcondition(prepared.plan)).toBe(true);
    expect((await inspectIOSProject(root)).appTargets[0]?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
  });

  test("links only the selected independent second application target", async () => {
    const root = await fixture({ secondTarget: true, clerkSDK: false });
    const before = mutableGraph(parsePbxProject(await readFile(pbxprojPath(root), "utf8")));
    const primaryArrays = targetArraySnapshot(before.objects, IOS_FIXTURE_IDS.appTarget);
    expect(before.objects[IOS_FIXTURE_IDS.secondTarget]?.buildPhases).toEqual([
      IOS_FIXTURE_IDS.secondSourcesPhase,
      IOS_FIXTURE_IDS.secondFrameworksPhase,
    ]);
    expect(before.objects[IOS_FIXTURE_IDS.secondSourcesPhase]?.files).toEqual([
      IOS_FIXTURE_IDS.secondSourceBuildFile,
    ]);
    expect(before.objects[IOS_FIXTURE_IDS.secondFrameworksPhase]?.files).toEqual([]);

    const plan = await planIOSSDKInstall({
      root,
      projectPath: "MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.secondTarget,
    });
    expect(plan.status).toBe("ready");
    expect((await applyIOSSDKInstall(plan)).status).toBe("applied");

    const after = mutableGraph(parsePbxProject(await readFile(pbxprojPath(root), "utf8")));
    expect(targetArraySnapshot(after.objects, IOS_FIXTURE_IDS.appTarget)).toBe(primaryArrays);

    const secondProductIds = after.objects[IOS_FIXTURE_IDS.secondTarget]
      ?.packageProductDependencies as string[];
    expect(secondProductIds).toHaveLength(1);
    expect(after.objects[secondProductIds[0]!]).toMatchObject({
      isa: "XCSwiftPackageProductDependency",
      productName: "ClerkKit",
    });
    const secondFrameworkFiles = after.objects[IOS_FIXTURE_IDS.secondFrameworksPhase]
      ?.files as string[];
    expect(secondFrameworkFiles).toHaveLength(1);
    expect(after.objects[secondFrameworkFiles[0]!]).toMatchObject({
      isa: "PBXBuildFile",
      productRef: secondProductIds[0],
    });

    const primaryInspection = await inspectIOSProject(root, {
      target: IOS_FIXTURE_IDS.appTarget,
    });
    const secondInspection = await inspectIOSProject(root, {
      target: IOS_FIXTURE_IDS.secondTarget,
    });
    expect(primaryInspection.appTargets[0]?.packages.clerkKit).toBe("absent");
    expect(secondInspection.appTargets[0]?.packages.clerkKit).toBe("linked");
  });

  test("optionally installs ClerkKitUI and repairs a declared but unlinked product", async () => {
    const cleanRoot = await fixture();
    await transformProject(cleanRoot, removeClerkSDK);
    const uiPlan = await planIOSSDKInstall(installOptions(cleanRoot, true));
    expect(uiPlan.status).toBe("ready");
    expect((await applyIOSSDKInstall(uiPlan)).status).toBe("applied");
    expect((await inspectIOSProject(cleanRoot)).appTargets[0]?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });

    const repairRoot = await fixture();
    await transformProject(repairRoot, (graph) => {
      graph.frameworks.files = [IOS_FIXTURE_IDS.clerkKitUIBuildFile];
      delete graph.objects[IOS_FIXTURE_IDS.clerkKitBuildFile];
    });
    const repairPlan = await planIOSSDKInstall(installOptions(repairRoot));
    expect(repairPlan.status).toBe("ready");
    expect(repairPlan.actions).toEqual([
      "Link ClerkKit in the selected target's Frameworks phase.",
    ]);
    expect((await applyIOSSDKInstall(repairPlan)).status).toBe("applied");
    expect((await inspectIOSProject(repairRoot)).appTargets[0]?.packages.clerkKit).toBe("linked");

    const missingPhaseRoot = await fixture();
    await transformProject(missingPhaseRoot, (graph) => {
      removeClerkSDK(graph);
      graph.target.buildPhases = [IOS_FIXTURE_IDS.sourcesPhase];
      delete graph.objects[IOS_FIXTURE_IDS.frameworksPhase];
    });
    const missingPhasePlan = await planIOSSDKInstall(installOptions(missingPhaseRoot));
    expect(missingPhasePlan.actions).toContain(
      "Create a Frameworks build phase for the selected target.",
    );
    expect((await applyIOSSDKInstall(missingPhasePlan)).status).toBe("applied");
    expect((await inspectIOSProject(missingPhaseRoot)).appTargets[0]?.packages.clerkKit).toBe(
      "linked",
    );
  });

  test("adds an iOS-only ClerkKit link when a multiplatform target already links it on macOS", async () => {
    const root = await fixture({ clerkSDK: "core-only" });
    await transformProject(root, (graph) => {
      for (const configurationId of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
        const settings = graph.objects[configurationId]!.buildSettings as Record<string, unknown>;
        settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
      }
      graph.objects[IOS_FIXTURE_IDS.clerkKitBuildFile]!.platformFilter = "macos";
    });

    const plan = await planIOSSDKInstall(installOptions(root));
    expect(plan.status).toBe("ready");
    expect(await applyIOSSDKInstall(plan)).toMatchObject({ status: "applied" });

    const graph = mutableGraph(parsePbxProject(await readFile(pbxprojPath(root), "utf8")));
    const links = (graph.frameworks.files as string[])
      .map((id) => graph.objects[id]!)
      .filter((object) => object.productRef === IOS_FIXTURE_IDS.clerkKit);
    expect(links).toHaveLength(2);
    expect(
      links
        .map((object) => object.platformFilter)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["ios", "macos"]);
    expect((await planIOSSDKInstall(installOptions(root))).status).toBe("satisfied");
  });

  test("reuses a verified local package and canonical remote URL variants", async () => {
    const localRoot = await fixture();
    await mkdir(join(localRoot, "LocalClerk", "Sources", "ClerkKit"), { recursive: true });
    await mkdir(join(localRoot, "LocalClerk", "Sources", "ClerkKitUI"), { recursive: true });
    await Bun.write(
      join(localRoot, "LocalClerk", "Package.swift"),
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Clerk",
  products: [
    .library(name: "ClerkKit", targets: ["ClerkKit"]),
    .library(name: "ClerkKitUI", targets: ["ClerkKitUI"]),
  ],
  targets: [
    .target(name: "ClerkKit", path: "Sources/ClerkKit"),
    .target(name: "ClerkKitUI", path: "Sources/ClerkKitUI"),
  ]
)
`,
    );
    await transformProject(localRoot, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage] = {
        isa: "XCLocalSwiftPackageReference",
        relativePath: "LocalClerk",
      };
      graph.root.packageReferences = [];
    });
    const localPlan = await planIOSSDKInstall(installOptions(localRoot));
    expect(localPlan).toMatchObject({ status: "ready" });
    expect(localPlan.actions).toEqual([
      "Attach the verified clerk-ios package reference to the Xcode project.",
    ]);
    expect((await applyIOSSDKInstall(localPlan)).status).toBe("applied");
    expect((await inspectIOSProject(localRoot)).appTargets[0]?.packages.package).toBe("local");

    const remoteRoot = await fixture();
    await transformProject(remoteRoot, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.repositoryURL =
        "git@github.com:clerk/clerk-ios.git";
    });
    const before = await readFile(pbxprojPath(remoteRoot));
    const remotePlan = await planIOSSDKInstall(installOptions(remoteRoot, true));
    expect(remotePlan.status).toBe("satisfied");
    expect((await applyIOSSDKInstall(remotePlan)).status).toBe("satisfied");
    expect(await readFile(pbxprojPath(remoteRoot))).toEqual(before);
  });

  test("does not trust Clerk product names mentioned only in a local manifest comment", async () => {
    const root = await fixture();
    await mkdir(join(root, "UnrelatedPackage"));
    await Bun.write(
      join(root, "UnrelatedPackage", "Package.swift"),
      '// swift-tools-version: 6.0\n// Package(name: "Clerk", products: [.library(name: "ClerkKit", targets: ["ClerkKit"])])\n',
    );
    await transformProject(root, (graph) => {
      graph.objects[IOS_FIXTURE_IDS.clerkPackage] = {
        isa: "XCLocalSwiftPackageReference",
        relativePath: "UnrelatedPackage",
      };
    });

    const before = await readFile(pbxprojPath(root));
    const plan = await planIOSSDKInstall(installOptions(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]?.code).toBe("wrong-package");
    expect(await readFile(pbxprojPath(root))).toEqual(before);
  });

  test("blocks unsafe or ambiguous selected-target graphs without writing", async () => {
    const cases: Array<{
      code: IOSSDKInstallBlockerCode;
      mutate: (graph: MutableGraph) => void;
    }> = [
      {
        code: "unattributed-product",
        mutate: (graph) => {
          delete graph.objects[IOS_FIXTURE_IDS.clerkKit]!.package;
        },
      },
      {
        code: "wrong-package",
        mutate: (graph) => {
          const wrongPackage = "919191919191919191919191";
          graph.objects[wrongPackage] = {
            isa: "XCRemoteSwiftPackageReference",
            repositoryURL: "https://github.com/example/not-clerk",
            requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
          };
          graph.root.packageReferences = [IOS_FIXTURE_IDS.clerkPackage, wrongPackage];
          graph.objects[IOS_FIXTURE_IDS.clerkKit]!.package = wrongPackage;
        },
      },
      {
        code: "ambiguous-package",
        mutate: (graph) => {
          const secondPackage = "929292929292929292929292";
          graph.objects[secondPackage] = {
            ...graph.objects[IOS_FIXTURE_IDS.clerkPackage]!,
          };
          graph.root.packageReferences = [IOS_FIXTURE_IDS.clerkPackage, secondPackage];
        },
      },
      {
        code: "duplicate-package",
        mutate: (graph) => {
          graph.root.packageReferences = [
            IOS_FIXTURE_IDS.clerkPackage,
            IOS_FIXTURE_IDS.clerkPackage,
          ];
        },
      },
      {
        code: "duplicate-product",
        mutate: (graph) => {
          graph.target.packageProductDependencies = [
            IOS_FIXTURE_IDS.clerkKit,
            IOS_FIXTURE_IDS.clerkKit,
          ];
        },
      },
      {
        code: "duplicate-build-file",
        mutate: (graph) => {
          graph.frameworks.files = [
            IOS_FIXTURE_IDS.clerkKitBuildFile,
            IOS_FIXTURE_IDS.clerkKitBuildFile,
          ];
        },
      },
      {
        code: "ambiguous-frameworks-phase",
        mutate: (graph) => {
          const secondPhase = "939393939393939393939393";
          graph.objects[secondPhase] = { ...graph.frameworks, files: [] };
          graph.target.buildPhases = [
            IOS_FIXTURE_IDS.sourcesPhase,
            IOS_FIXTURE_IDS.frameworksPhase,
            secondPhase,
          ];
        },
      },
      {
        code: "unsupported-project",
        mutate: (graph) => {
          graph.objects[IOS_FIXTURE_IDS.clerkKitBuildFile]!.platformFilter = "futureOS";
        },
      },
      {
        code: "unsupported-project",
        mutate: (graph) => {
          graph.objects[IOS_FIXTURE_IDS.clerkPackage]!.requirement = {
            kind: "upToNextMajorVersion",
          };
        },
      },
    ];

    for (const item of cases) {
      const root = await fixture();
      await transformProject(root, item.mutate);
      const before = await treeDigest(root);
      const plan = await planIOSSDKInstall(installOptions(root));
      expect(plan.status).toBe("blocked");
      expect(plan.blockers[0]?.code).toBe(item.code);
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("allows generated no-ops but blocks generated writes and project symlink escapes", async () => {
    const satisfiedGeneratedRoot = await fixture();
    await Bun.write(join(satisfiedGeneratedRoot, "project.yml"), "name: MyApp\n");
    expect((await planIOSSDKInstall(installOptions(satisfiedGeneratedRoot))).status).toBe(
      "satisfied",
    );

    const generatedRoot = await fixture();
    await transformProject(generatedRoot, removeClerkSDK);
    await Bun.write(join(generatedRoot, "project.yml"), "name: MyApp\n");
    const generatedBefore = await treeDigest(generatedRoot);
    const generatedPlan = await planIOSSDKInstall(installOptions(generatedRoot));
    expect(generatedPlan.blockers[0]?.code).toBe("generated-project");
    expect(await treeDigest(generatedRoot)).toEqual(generatedBefore);

    const nestedRoot = await temporaryRoot();
    await mkdir(join(nestedRoot, "ios"));
    await createIOSFixture(join(nestedRoot, "ios"));
    await transformProject(join(nestedRoot, "ios"), removeClerkSDK);
    await Bun.write(join(nestedRoot, "ios", "project.yml"), "name: MyApp\n");
    const nestedPlan = await planIOSSDKInstall({
      ...installOptions(nestedRoot),
      projectPath: "ios/MyApp.xcodeproj",
    });
    expect(nestedPlan.blockers[0]?.code).toBe("generated-project");

    const outside = await temporaryRoot("clerk-ios-install-outside-");
    await createIOSFixture(outside);
    const symlinkRoot = await temporaryRoot();
    await symlink(join(outside, "MyApp.xcodeproj"), join(symlinkRoot, "MyApp.xcodeproj"));
    const escapedBefore = await treeDigest(symlinkRoot);
    const escapedPlan = await planIOSSDKInstall(installOptions(symlinkRoot));
    expect(escapedPlan.blockers[0]?.code).toBe("external-path");
    expect(await treeDigest(symlinkRoot)).toEqual(escapedBefore);

    const leafRoot = await fixture();
    const leaf = pbxprojPath(leafRoot);
    const realLeaf = join(leafRoot, "MyApp.xcodeproj", "actual.pbxproj");
    await rename(leaf, realLeaf);
    await symlink("actual.pbxproj", leaf);
    const leafBefore = await treeDigest(leafRoot);
    const leafPlan = await planIOSSDKInstall(installOptions(leafRoot));
    expect(leafPlan.blockers[0]?.code).toBe("unreadable-project");
    expect(await treeDigest(leafRoot)).toEqual(leafBefore);
  });

  test("rejects a stale plan and preserves the newer bytes", async () => {
    const root = await fixture();
    await transformProject(root, removeClerkSDK);
    const plan = await planIOSSDKInstall(installOptions(root));
    expect(plan.status).toBe("ready");

    await appendFile(pbxprojPath(root), "\n// newer user edit\n");
    const newerBytes = await readFile(pbxprojPath(root));
    const prepared = await prepareIOSSDKInstallMutation(plan);
    expect(prepared.status).toBe("stale");
    expect("mutation" in prepared).toBe(false);
    const result = await applyIOSSDKInstall(plan);
    expect(result.status).toBe("stale");
    expect(await readFile(pbxprojPath(root))).toEqual(newerBytes);
    expect(
      (await readdir(join(root, "MyApp.xcodeproj"))).some((name) => name.includes(".clerk-")),
    ).toBe(false);
  });
});
