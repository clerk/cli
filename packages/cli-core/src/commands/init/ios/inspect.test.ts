import { afterEach, describe, expect, test } from "bun:test";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { discoverIOSContainers, inspectWorkspace } from "./discovery.ts";
import { inspectIOSProject, inspectIOSSourceMembership } from "./inspect.ts";
import { recoverIOSFileTransactions } from "./file-transaction.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const FILE_TRANSACTION_MODULE = `${import.meta.dir}/file-transaction.ts`;

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-inspect-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, options);
  return root;
}

async function interruptProjectFileTransaction(root: string, path: string): Promise<void> {
  const source = `
    const { readFile, lstat } = await import("node:fs/promises");
    const {
      applyIOSExistingFileTransaction,
      hashIOSFileBytes,
      prepareIOSFileMutationBoundary,
    } = await import(${JSON.stringify(FILE_TRANSACTION_MODULE)});
    const root = ${JSON.stringify(root)};
    const path = ${JSON.stringify(path)};
    const originalBytes = new Uint8Array(await readFile(path));
    const candidateBytes = new TextEncoder().encode("candidate project bytes\\n");
    const boundary = await prepareIOSFileMutationBoundary(root, path);
    const info = await lstat(path);
    await applyIOSExistingFileTransaction([
      {
        path,
        boundary,
        originalBytes,
        originalHash: hashIOSFileBytes(originalBytes),
        candidateBytes,
        candidateHash: hashIOSFileBytes(candidateBytes),
        mode: info.mode & 0o7777,
      },
    ], [async () => true], {
      afterExistingDestinationClaim: () => process.kill(process.pid, "SIGKILL"),
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

async function transformProject(
  root: string,
  transform: (objects: PbxObjects) => void,
): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  await transformProjectAt(projectPath, transform);
}

async function transformProjectAt(
  projectPath: string,
  transform: (objects: PbxObjects) => void,
): Promise<void> {
  const project = parsePbxProject(await Bun.file(projectPath).text());
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  transform(objects);
  await Bun.write(projectPath, buildPbxProject(project));
}

async function addProjectReference(
  ownerProjectPath: string,
  referencedProjectPath: string,
  referenceId: string,
): Promise<void> {
  await transformProjectAt(join(ownerProjectPath, "project.pbxproj"), (objects) => {
    objects[referenceId] = {
      isa: "PBXFileReference",
      lastKnownFileType: "wrapper.pb-project",
      path: relative(dirname(ownerProjectPath), referencedProjectPath),
      sourceTree: "SOURCE_ROOT",
    };
    objects[IOS_FIXTURE_IDS.project]!.projectReferences = [{ ProjectRef: referenceId }];
  });
}

async function makeFixtureExtensionOwnSource(
  projectRoot: string,
  sourcePath: string,
): Promise<void> {
  await transformProject(projectRoot, (objects) => {
    objects[IOS_FIXTURE_IDS.appTarget]!.productType = "com.apple.product-type.app-extension";
    objects[IOS_FIXTURE_IDS.appFile]!.path = relative(projectRoot, sourcePath);
    objects[IOS_FIXTURE_IDS.appFile]!.sourceTree = "SOURCE_ROOT";
  });
}

async function addSynchronizedTargetRoot(root: string, path = "Synced"): Promise<void> {
  const groupId = "474747474747474747474747";
  await transformProject(root, (objects) => {
    objects[groupId] = {
      isa: "PBXFileSystemSynchronizedRootGroup",
      path,
      sourceTree: "<group>",
    };
    objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [groupId];
  });
}

function localSecretsPlist(host: string): string {
  const encodedHost = Buffer.from(`${host}$`).toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>pk_test_${encodedHost}</string></dict></plist>`;
}

async function writeStructurallyValidLocalClerkPackage(root: string): Promise<void> {
  const packageRoot = join(root, "LocalClerk");
  await mkdir(join(packageRoot, "Sources", "ClerkKit"), { recursive: true });
  await mkdir(join(packageRoot, "Sources", "ClerkKitUI"), { recursive: true });
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
    .target(name: "ClerkKit"),
    .target(name: "ClerkKitUI"),
  ]
)
`,
  );
}

async function setAssociatedDomainTemplate(root: string, template: string): Promise<void> {
  const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
  const entitlements = await Bun.file(entitlementsPath).text();
  await Bun.write(
    entitlementsPath,
    entitlements.replace("webcredentials:clerk.example.test", template),
  );
}

async function addAppleEntitlement(root: string, value: string): Promise<void> {
  const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
  const entitlements = await Bun.file(entitlementsPath).text();
  await Bun.write(
    entitlementsPath,
    entitlements.replace("</dict>", `<key>com.apple.developer.applesignin</key>${value}\n</dict>`),
  );
}

async function addTargetBuildSettings(
  root: string,
  settings: Array<[key: string, value: string]>,
): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = await Bun.file(projectPath).text();
  const serialized = settings
    .map(([key, value]) => `"${key.replaceAll('"', '\\"')}" = "${value.replaceAll('"', '\\"')}";`)
    .join(" ");
  await Bun.write(
    projectPath,
    project.replaceAll(
      'SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";',
      `${serialized} SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";`,
    ),
  );
}

async function writeSelectedTargetRunSchemeKey(root: string, value: string): Promise<string> {
  const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
  await mkdir(schemeDirectory, { recursive: true });
  const schemePath = join(schemeDirectory, "MyApp.xcscheme");
  await Bun.write(
    schemePath,
    `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${value}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`,
  );
  return schemePath;
}

function selectedTargetRunScheme(value: string, referencedContainer?: string): string {
  const containerAttribute = referencedContainer
    ? ` ReferencedContainer="container:${referencedContainer}"`
    : "";
  return `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}"${containerAttribute} /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${value}" isEnabled="YES" /></EnvironmentVariables></LaunchAction></Scheme>`;
}

async function fillProjectSchemeLimit(root: string, finalScheme: string): Promise<void> {
  const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
  await mkdir(schemeDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: 99 }, (_, index) =>
      Bun.write(join(schemeDirectory, `A${String(index).padStart(3, "0")}.xcscheme`), "<Scheme />"),
    ),
  );
  await Bun.write(join(schemeDirectory, "ZRuntime.xcscheme"), finalScheme);
}

async function writeWorkspaceRunScheme(root: string, name: string, source: string): Promise<void> {
  const schemeDirectory = join(root, "MyApp.xcworkspace", "xcshareddata", "xcschemes");
  await mkdir(schemeDirectory, { recursive: true });
  await Bun.write(join(schemeDirectory, name), source);
}

async function writeDeepWorkspaceRunScheme(root: string, source: string): Promise<void> {
  const workspace = join(root, "One", "Two", "Three", "Four", "Deep.xcworkspace");
  const schemeDirectory = join(workspace, "xcshareddata", "xcschemes");
  await mkdir(schemeDirectory, { recursive: true });
  await Bun.write(
    join(workspace, "contents.xcworkspacedata"),
    '<Workspace version="1.0"><FileRef location="group:../../../../MyApp.xcodeproj" /></Workspace>',
  );
  await Bun.write(join(schemeDirectory, "DeepRuntime.xcscheme"), source);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("discoverIOSContainers", () => {
  test("marks a skipped symlinked Xcode container incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-discovery-"));
    temporaryDirectories.push(root);
    const project = join(root, "Real.xcodeproj");
    await mkdir(project);
    await symlink(project, join(root, "Linked.xcodeproj"), "dir");

    const discovery = await discoverIOSContainers(root, { exhaustive: true });

    expect(discovery.projectPaths).toEqual([project]);
    expect(discovery.complete).toBe(false);
  });

  test("marks symlinked and unreadable traversal paths incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-discovery-"));
    temporaryDirectories.push(root);
    const linkedDirectory = join(root, "LinkedProjects");
    const targetDirectory = join(root, "TargetProjects");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, linkedDirectory, "dir");
    await symlink(join(root, "MissingProjects"), join(root, "BrokenProjects"), "dir");

    const discovery = await discoverIOSContainers(root, { exhaustive: true });

    expect(discovery.complete).toBe(false);
  });

  test("does not taint discovery for file links or ignored directory links", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-discovery-"));
    temporaryDirectories.push(root);
    const file = join(root, "Configuration.txt");
    const ignoredTarget = join(root, "IgnoredTarget");
    await Bun.write(file, "configuration");
    await mkdir(ignoredTarget);
    await symlink(file, join(root, "LinkedConfiguration.txt"), "file");
    await symlink(ignoredTarget, join(root, "Pods"), "dir");

    const discovery = await discoverIOSContainers(root, { exhaustive: true });

    expect(discovery.complete).toBe(true);
  });

  test("traverses referenced projects inside ignored directories and records shared source ownership", async () => {
    const root = await fixture({ complete: true });
    const referencedRoot = join(root, "Pods", "ReferencedApp");
    await createIOSFixture(referencedRoot, { complete: true, includeKey: false });
    await makeFixtureExtensionOwnSource(referencedRoot, join(root, "MyApp", "MyAppApp.swift"));
    const primaryProject = join(root, "MyApp.xcodeproj");
    const referencedProject = join(referencedRoot, "MyApp.xcodeproj");
    await addProjectReference(primaryProject, referencedProject, "515151515151515151515151");

    const discovery = await discoverIOSContainers(root, { exhaustive: true });
    const memberships = await inspectIOSSourceMembership(root);
    const owners = memberships.filter((membership) =>
      membership.files.some((file) => file.relativePath === "MyApp/MyAppApp.swift"),
    );

    expect(discovery).toMatchObject({ complete: true, projectReferencesComplete: true });
    expect(discovery.projectPaths).toEqual([primaryProject, referencedProject].sort());
    expect(owners).toHaveLength(2);
    expect(owners.every((membership) => membership.complete)).toBe(true);
    expect(owners.map((membership) => membership.projectPath).sort()).toEqual([
      "MyApp.xcodeproj",
      "Pods/ReferencedApp/MyApp.xcodeproj",
    ]);
  });

  test("marks external sibling project references incomplete for semantic ownership", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clerk-ios-project-reference-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "App");
    const siblingRoot = join(parent, "Sibling");
    await createIOSFixture(root, { complete: true });
    await createIOSFixture(siblingRoot, { complete: true, includeKey: false });
    await makeFixtureExtensionOwnSource(siblingRoot, join(root, "MyApp", "MyAppApp.swift"));
    const primaryProject = join(root, "MyApp.xcodeproj");
    await addProjectReference(
      primaryProject,
      join(siblingRoot, "MyApp.xcodeproj"),
      "525252525252525252525252",
    );

    const discovery = await discoverIOSContainers(root, { exhaustive: true });
    const inspection = await inspectIOSProject(root);
    const memberships = await inspectIOSSourceMembership(root);

    expect(discovery).toMatchObject({ complete: false, projectReferencesComplete: false });
    expect(discovery.projectPaths).toEqual([primaryProject]);
    expect(inspection.selection).toMatchObject({ state: "selected", targetName: "MyApp" });
    expect(inspection.appTargets[0]?.swift.evidenceComplete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-source-membership",
        severity: "warning",
      }),
    );
    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((membership) => !membership.complete)).toBe(true);
  });

  test("terminates complete project-reference cycles", async () => {
    const root = await fixture({ complete: true });
    const referencedRoot = join(root, "Pods", "ReferencedApp");
    await createIOSFixture(referencedRoot, { complete: true, includeKey: false });
    await makeFixtureExtensionOwnSource(
      referencedRoot,
      join(referencedRoot, "MyApp", "MyAppApp.swift"),
    );
    const primaryProject = join(root, "MyApp.xcodeproj");
    const referencedProject = join(referencedRoot, "MyApp.xcodeproj");
    await addProjectReference(primaryProject, referencedProject, "535353535353535353535353");
    await addProjectReference(referencedProject, primaryProject, "545454545454545454545454");

    const discovery = await discoverIOSContainers(root, { exhaustive: true });

    expect(discovery).toMatchObject({ complete: true, projectReferencesComplete: true });
    expect(discovery.projectPaths).toEqual([primaryProject, referencedProject].sort());
  });

  test("fails project-reference discovery closed for malformed records", async () => {
    const root = await fixture({ complete: true });
    await transformProject(root, (objects) => {
      objects[IOS_FIXTURE_IDS.project]!.projectReferences = [{}];
    });

    const discovery = await discoverIOSContainers(root, { exhaustive: true });
    const inspection = await inspectIOSProject(root);

    expect(discovery).toMatchObject({ complete: false, projectReferencesComplete: false });
    expect(inspection.appTargets[0]?.swift.evidenceComplete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
    );
  });
});

describe("inspectIOSProject", () => {
  test("reports interrupted file transactions without recovering or changing project bytes", async () => {
    const root = await fixture({ complete: true });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const originalProject = await readFile(projectPath);
    await interruptProjectFileTransaction(root, projectPath);

    await expect(lstat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
    const beforeInspection = await treeDigest(root);
    const inspection = await inspectIOSProject(root);

    expect(inspection).toMatchObject({
      selection: { state: "none" },
      diagnostics: [
        {
          code: "xcode.interrupted-file-transaction",
          severity: "error",
        },
      ],
    });
    expect(await treeDigest(root)).toEqual(beforeInspection);
    await expect(lstat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });

    await recoverIOSFileTransactions(root);
    expect(Buffer.from(await readFile(projectPath))).toEqual(Buffer.from(originalProject));
    expect((await inspectIOSProject(root)).selection).toMatchObject({
      state: "selected",
      targetName: "MyApp",
    });
  }, 15_000);

  test("fails source ownership closed when a project-container link is skipped", async () => {
    const root = await fixture({ complete: true });
    const project = join(root, "MyApp.xcodeproj");
    await symlink(project, join(root, "Linked.xcodeproj"), "dir");

    const memberships = await inspectIOSSourceMembership(root);

    expect(memberships.length).toBeGreaterThan(0);
    expect(memberships.every((membership) => !membership.complete)).toBe(true);
  });

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
      evidenceComplete: true,
      found: false,
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

  test("does not attribute a Clerk product to an unrelated declared clerk-ios package", async () => {
    const root = await fixture({ clerkSDK: "core-only" });
    const wrongPackageId = "272727272727272727272727";
    await transformProject(root, (objects) => {
      objects[wrongPackageId] = {
        isa: "XCRemoteSwiftPackageReference",
        repositoryURL: "https://github.com/example/not-clerk",
        requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
      };
      objects[IOS_FIXTURE_IDS.project]!.packageReferences = [
        IOS_FIXTURE_IDS.clerkPackage,
        wrongPackageId,
      ];
      objects[IOS_FIXTURE_IDS.clerkKit]!.package = wrongPackageId;
    });

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.packages).toEqual({
      package: "unattributed",
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
    expect(
      inspection.diagnostics.some((diagnostic) => diagnostic.code === "clerk.package-unattributed"),
    ).toBe(true);
  });

  test.each([
    {
      name: "another package",
      transform(objects: PbxObjects) {
        const wrongPackageId = "272727272727272727272727";
        objects[wrongPackageId] = {
          isa: "XCRemoteSwiftPackageReference",
          repositoryURL: "https://github.com/example/not-clerk",
          requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
        };
        objects[IOS_FIXTURE_IDS.clerkKitUI]!.package = wrongPackageId;
      },
    },
    {
      name: "an unresolved package",
      transform(objects: PbxObjects) {
        objects[IOS_FIXTURE_IDS.clerkKitUI]!.package = "282828282828282828282828";
      },
    },
    {
      name: "no package",
      transform(objects: PbxObjects) {
        delete objects[IOS_FIXTURE_IDS.clerkKitUI]!.package;
      },
    },
  ])("fails closed when Clerk products have mixed attribution to $name", async ({ transform }) => {
    const root = await fixture();
    await transformProject(root, transform);

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.packages).toEqual({
      package: "unattributed",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
  });

  test.each(["remote", "local"] as const)(
    "preserves the %s Clerk package fallback when all products lack attribution",
    async (kind) => {
      const root = await fixture({ clerkSDK: "core-only" });
      if (kind === "local") {
        await writeStructurallyValidLocalClerkPackage(root);
      }
      await transformProject(root, (objects) => {
        delete objects[IOS_FIXTURE_IDS.clerkKit]!.package;
        if (kind === "local") {
          objects[IOS_FIXTURE_IDS.clerkPackage] = {
            isa: "XCLocalSwiftPackageReference",
            relativePath: "LocalClerk",
          };
        }
      });

      const inspection = await inspectIOSProject(root);

      expect(inspection.appTargets[0]?.packages).toEqual({
        package: kind,
        clerkKit: "linked",
        clerkKitUI: "absent",
      });
    },
  );

  test.each([
    {
      name: "comment",
      manifest: `// swift-tools-version: 6.0
import PackageDescription
// Package(name: "Clerk", products: [.library(name: "ClerkKit", targets: ["ClerkKit"]), .library(name: "ClerkKitUI", targets: ["ClerkKitUI"])], targets: [.target(name: "ClerkKit"), .target(name: "ClerkKitUI")])
let package = Package(name: "Other")
`,
    },
    {
      name: "dependency",
      manifest: `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Other",
  dependencies: [.package(url: "https://github.com/clerk/clerk-ios", from: "1.0.0")],
  targets: [.target(name: "Other", dependencies: [.product(name: "ClerkKit", package: "clerk-ios"), .product(name: "ClerkKitUI", package: "clerk-ios")])]
)
`,
    },
    {
      name: "product-only declaration",
      manifest: `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Clerk",
  products: [
    .library(name: "ClerkKit", targets: ["ClerkKit"]),
    .library(name: "ClerkKitUI", targets: ["ClerkKitUI"]),
  ],
  targets: [.target(name: "Other")]
)
`,
    },
  ])("does not attribute a local package from a $name decoy", async ({ manifest }) => {
    const root = await fixture({ clerkSDK: "core-only" });
    await mkdir(join(root, "LocalClerk", "Sources", "ClerkKit"), { recursive: true });
    await mkdir(join(root, "LocalClerk", "Sources", "ClerkKitUI"), { recursive: true });
    await Bun.write(join(root, "LocalClerk", "Package.swift"), manifest);
    await transformProject(root, (objects) => {
      objects[IOS_FIXTURE_IDS.clerkPackage] = {
        isa: "XCLocalSwiftPackageReference",
        relativePath: "LocalClerk",
      };
    });

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.packages).toEqual({
      package: "unattributed",
      clerkKit: "linked",
      clerkKitUI: "absent",
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "clerk.package-unattributed" }),
    );
  });

  test("preserves absent, exact, and invalid Apple entitlement states", async () => {
    const cases = [
      {
        name: "absent",
        expectedState: "absent",
        expectedExact: false,
      },
      {
        name: "exact",
        value: "<array><string>Default</string></array>",
        expectedState: "exact",
        expectedExact: true,
      },
      {
        name: "empty array",
        value: "<array></array>",
        expectedState: "invalid",
        expectedExact: false,
      },
      {
        name: "wrong value type",
        value: "<string>Default</string>",
        expectedState: "invalid",
        expectedExact: false,
      },
      {
        name: "non-Default array",
        value: "<array><string>PrimaryApp</string></array>",
        expectedState: "invalid",
        expectedExact: false,
      },
      {
        name: "multi-value array",
        value: "<array><string>Default</string><string>PrimaryApp</string></array>",
        expectedState: "invalid",
        expectedExact: false,
      },
    ] as const;

    for (const testCase of cases) {
      const root = await fixture({ complete: true });
      if ("value" in testCase) await addAppleEntitlement(root, testCase.value);

      const inspection = await inspectIOSProject(root);
      const entitlements = inspection.appTargets[0]?.configurations.map(
        (configuration) => configuration.entitlements,
      );

      expect(entitlements, testCase.name).toHaveLength(2);
      expect(
        entitlements?.every(
          (value) =>
            value?.signInWithAppleState === testCase.expectedState &&
            value.signInWithApple === testCase.expectedExact,
        ),
        testCase.name,
      ).toBe(true);
      expect(
        inspection.diagnostics.some(
          (diagnostic) => diagnostic.code === "xcode.invalid-apple-entitlement",
        ),
        testCase.name,
      ).toBe(testCase.expectedState === "invalid");
    }
  });

  test("resolves matching associated-domain variables across device and simulator contexts", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphonesimulator*]", "clerk.example.test"],
    ]);
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: ["webcredentials:clerk.example.test"],
      unresolvedAssociatedDomains: [],
    });
  });

  test("leaves associated-domain variables unresolved when device and simulator differ", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphonesimulator*]", "simulator.example.test"],
    ]);
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: [],
      unresolvedAssociatedDomains: ["webcredentials:$(ASSOCIATED_DOMAIN_HOST)"],
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.unresolved-build-setting",
        message: expect.stringContaining("associated-domain values"),
      }),
    );
  });

  test("leaves associated-domain variables unresolved when x86_64 simulator differs", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphonesimulator*][arch=arm64]", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphonesimulator*][arch=x86_64]", "intel.example.test"],
    ]);
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: [],
      unresolvedAssociatedDomains: ["webcredentials:$(ASSOCIATED_DOMAIN_HOST)"],
    });
  });

  test("ignores simulator-only associated-domain values for device-only targets", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphonesimulator*]", "simulator.example.test"],
    ]);
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project.replaceAll(
        'SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";',
        "SUPPORTED_PLATFORMS = iphoneos;",
      ),
    );
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: ["webcredentials:clerk.example.test"],
      unresolvedAssociatedDomains: [],
    });
  });

  test("ignores device-only associated-domain values for simulator-only targets", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["ASSOCIATED_DOMAIN_HOST[sdk=iphoneos*]", "stale-device.example.test"],
    ]);
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = await Bun.file(projectPath).text();
    await Bun.write(
      projectPath,
      project.replaceAll(
        'SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";',
        "SUPPORTED_PLATFORMS = iphonesimulator;",
      ),
    );
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: ["webcredentials:clerk.example.test"],
      unresolvedAssociatedDomains: [],
    });
  });

  test("propagates referenced build-setting taints into associated-domain expansion", async () => {
    const root = await fixture({ complete: true });
    await addTargetBuildSettings(root, [
      ["ASSOCIATED_DOMAIN_HOST", "clerk.example.test"],
      ["DOMAIN_WRAPPER", "$(ASSOCIATED_DOMAIN_HOST)"],
      ["ASSOCIATED_DOMAIN_HOST[variant=unsupported]", "unknown.example.test"],
    ]);
    await setAssociatedDomainTemplate(root, "webcredentials:$(DOMAIN_WRAPPER)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: [],
      unresolvedAssociatedDomains: ["webcredentials:$(DOMAIN_WRAPPER)"],
    });
  });

  test("fails associated-domain expansion closed after an incomplete xcconfig include", async () => {
    const root = await fixture({ complete: true, xcconfig: true });
    const xcconfigPath = join(root, "Config", "Target.xcconfig");
    const xcconfig = await Bun.file(xcconfigPath).text();
    await Bun.write(
      xcconfigPath,
      `${xcconfig}ASSOCIATED_DOMAIN_HOST = clerk.example.test\n#include "Missing.xcconfig"\n`,
    );
    await setAssociatedDomainTemplate(root, "webcredentials:$(ASSOCIATED_DOMAIN_HOST)");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: [],
      unresolvedAssociatedDomains: ["webcredentials:$(ASSOCIATED_DOMAIN_HOST)"],
    });
  });

  test("keeps literal associated domains resolved when build-setting inputs are incomplete", async () => {
    const root = await fixture({ complete: true, xcconfig: true });
    const xcconfigPath = join(root, "Config", "Target.xcconfig");
    const xcconfig = await Bun.file(xcconfigPath).text();
    await Bun.write(xcconfigPath, `${xcconfig}#include "Missing.xcconfig"\n`);

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: ["webcredentials:clerk.example.test"],
      unresolvedAssociatedDomains: [],
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

  test("does not treat watchOS products with stale iOS settings as iOS app candidates", async () => {
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
      evidenceComplete: true,
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
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "clerk.unconsumed-publishable-key-source",
        severity: "warning",
        message: expect.stringContaining("LocalSecrets.plist"),
        evidence: [{ path: "MyApp/LocalSecrets.plist", keyPath: "CLERK_PUBLISHABLE_KEY" }],
      }),
    );
    expect(JSON.stringify(inspection)).not.toContain("pk_live_");
  });

  test("reads LocalSecrets.plist from a completely discovered synchronized target root", async () => {
    const root = await fixture({ complete: true, includeKey: false });
    await addSynchronizedTargetRoot(root);
    await mkdir(join(root, "Synced", "Configuration"), { recursive: true });
    await Bun.write(
      join(root, "Synced", "Configuration", "LocalSecrets.plist"),
      localSecretsPlist("synchronized.clerk.example"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toMatchObject({
      evidenceComplete: true,
      found: true,
      source: "Synced/Configuration/LocalSecrets.plist",
      frontendApiHost: "synchronized.clerk.example",
    });
  });

  test("fails closed when a discovered LocalSecrets.plist is followed by depth-truncated evidence", async () => {
    const root = await fixture({ complete: true, includeKey: false });
    await addSynchronizedTargetRoot(root);
    await mkdir(join(root, "Synced", "00-visible"), { recursive: true });
    await Bun.write(
      join(root, "Synced", "00-visible", "LocalSecrets.plist"),
      localSecretsPlist("visible.clerk.example"),
    );
    const hiddenDirectory = join(
      root,
      "Synced",
      "10-deep",
      "level-1",
      "level-2",
      "level-3",
      "level-4",
      "level-5",
    );
    await mkdir(hiddenDirectory, { recursive: true });
    await Bun.write(
      join(hiddenDirectory, "LocalSecrets.plist"),
      localSecretsPlist("hidden.clerk.example"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: ["Synced/00-visible/LocalSecrets.plist"],
      invalidSources: [],
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-local-secrets-discovery",
        message: expect.stringContaining("MyApp"),
      }),
    );
    expect(inspection.localPublishableKey).not.toHaveProperty("source");
    expect(inspection.localPublishableKey).not.toHaveProperty("frontendApiHost");
  });

  test("fails closed when synchronized LocalSecrets discovery exceeds its file bound", async () => {
    const root = await fixture({ complete: true, includeKey: false });
    await addSynchronizedTargetRoot(root);
    for (let index = 0; index < 21; index += 1) {
      const directory = join(root, "Synced", String(index).padStart(2, "0"));
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, "LocalSecrets.plist"),
        localSecretsPlist(`bounded-${index}.clerk.example`),
      );
    }

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey.evidenceComplete).toBe(false);
    expect(inspection.localPublishableKey.found).toBe(false);
    expect(inspection.localPublishableKey.candidateSources).toHaveLength(20);
    expect(inspection.localPublishableKey).not.toHaveProperty("source");
    expect(inspection.localPublishableKey).not.toHaveProperty("frontendApiHost");
  });

  test("fails closed when synchronized LocalSecrets discovery skips a symlink", async () => {
    if (process.platform === "win32") return;
    const root = await fixture({ complete: true, includeKey: false });
    await addSynchronizedTargetRoot(root);
    const externalRoot = await mkdtemp(join(tmpdir(), "clerk-ios-local-secrets-"));
    temporaryDirectories.push(externalRoot);
    await Bun.write(
      join(externalRoot, "LocalSecrets.plist"),
      localSecretsPlist("external.clerk.example"),
    );
    await mkdir(join(root, "Synced"), { recursive: true });
    await symlink(externalRoot, join(root, "Synced", "LinkedSecrets"));

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-local-secrets-discovery",
        evidence: [{ path: "Synced/LinkedSecrets" }],
      }),
    );
  });

  test("fails closed when a target-owned LocalSecrets.plist resolves outside the project", async () => {
    if (process.platform === "win32") return;
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const externalRoot = await mkdtemp(join(tmpdir(), "clerk-ios-local-secrets-"));
    temporaryDirectories.push(externalRoot);
    const externalPath = join(externalRoot, "LocalSecrets.plist");
    await Bun.write(externalPath, localSecretsPlist("external.clerk.example"));
    await rm(join(root, "MyApp", "LocalSecrets.plist"));
    await symlink(externalPath, join(root, "MyApp", "LocalSecrets.plist"));

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
    });
    expect(inspection.appTargets[0]?.runtimeKeySinks).toEqual([]);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-local-secrets-discovery",
        evidence: [{ path: "MyApp/LocalSecrets.plist" }],
      }),
    );
  });

  test("treats a direct @main literal as the selected target's runtime key without exposing it", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const publishableKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    const schemeKey = `pk_live_${Buffer.from("scheme.clerk.example$").toString("base64")}`;
    const localSecretsKey = `pk_live_${Buffer.from("native.clerk.example$").toString("base64")}`;
    await writeSelectedTargetRunSchemeKey(root, schemeKey);
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
      evidenceComplete: true,
      found: true,
      conflict: false,
      source: "MyApp/MyAppApp.swift",
      frontendApiHost: "inline.clerk.example",
      instanceType: "development",
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
        "MyApp/MyAppApp.swift",
      ],
      invalidSources: [],
    });
    expect(JSON.stringify(inspection)).not.toContain(publishableKey);
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
    expect(JSON.stringify(inspection)).not.toContain(localSecretsKey);
  });

  test("does not fall through from an invalid app-init literal to other key sources", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const invalidInlineKey = "pk_test_inline-secret-must-not-leak";
    const schemeKey = `pk_test_${Buffer.from("scheme.clerk.example$").toString("base64")}`;
    await writeSelectedTargetRunSchemeKey(root, schemeKey);
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${invalidInlineKey}")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: false,
      source: "MyApp/MyAppApp.swift",
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
        "MyApp/MyAppApp.swift",
      ],
      invalidSources: ["MyApp/MyAppApp.swift"],
    });
    expect(JSON.stringify(inspection)).not.toContain(invalidInlineKey);
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
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
      evidenceComplete: true,
      found: true,
      source: "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
      frontendApiHost: "scheme.clerk.example",
      conflict: false,
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "clerk.unconsumed-publishable-key-source",
        severity: "warning",
        message: expect.stringContaining("Run-scheme key"),
        evidence: [
          {
            path: "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
            keyPath: "CLERK_PUBLISHABLE_KEY",
          },
        ],
      }),
    );
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
  });

  test("fails closed when bounded scheme discovery hides a conflicting workspace key", async () => {
    const root = await fixture({ includeKey: false, workspace: true });
    const visibleKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    await fillProjectSchemeLimit(root, selectedTargetRunScheme(visibleKey));
    await writeWorkspaceRunScheme(
      root,
      "WorkspaceRuntime.xcscheme",
      selectedTargetRunScheme(hiddenKey, "MyApp.xcodeproj"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: ["MyApp.xcodeproj/xcshareddata/xcschemes/ZRuntime.xcscheme"],
      invalidSources: [],
    });
    expect(inspection.localPublishableKey.frontendApiHost).toBeUndefined();
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-scheme-discovery",
        severity: "warning",
        evidence: expect.arrayContaining([{ path: "MyApp.xcworkspace/xcshareddata" }]),
      }),
    );
    expect(JSON.stringify(inspection)).not.toContain(visibleKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenKey);
  });

  test("fails closed when bounded container discovery hides a conflicting workspace scheme", async () => {
    const root = await fixture({ includeKey: false });
    const visibleKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    await writeSelectedTargetRunSchemeKey(root, visibleKey);
    await writeDeepWorkspaceRunScheme(
      root,
      selectedTargetRunScheme(hiddenKey, "../../../../MyApp.xcodeproj"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: ["MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme"],
      invalidSources: [],
    });
    expect(inspection.localPublishableKey.frontendApiHost).toBeUndefined();
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.incomplete-scheme-discovery",
        severity: "warning",
        evidence: expect.arrayContaining([{ path: "." }]),
      }),
    );
    expect(JSON.stringify(inspection)).not.toContain(visibleKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenKey);
  });

  test("fails closed when exhaustive container discovery reaches its depth bound", async () => {
    const root = await fixture({ includeKey: false });
    const visibleKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    await writeSelectedTargetRunSchemeKey(root, visibleKey);

    const nesting = Array.from({ length: 25 }, (_, index) => `Level${index}`);
    const workspace = join(root, ...nesting, "Deep.xcworkspace");
    const schemeDirectory = join(workspace, "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const projectReference = `${"../".repeat(nesting.length)}MyApp.xcodeproj`;
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      `<Workspace version="1.0"><FileRef location="group:${projectReference}" /></Workspace>`,
    );
    await Bun.write(
      join(schemeDirectory, "DeepRuntime.xcscheme"),
      selectedTargetRunScheme(hiddenKey, projectReference),
    );

    const inspection = await inspectIOSProject(root, { exhaustiveContainerDiscovery: true });

    expect(inspection.localPublishableKey).toMatchObject({
      evidenceComplete: false,
      found: false,
      conflict: false,
    });
    expect(inspection.localPublishableKey.frontendApiHost).toBeUndefined();
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-scheme-discovery" }),
    );
    expect(JSON.stringify(inspection)).not.toContain(visibleKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenKey);
  });

  test("keeps a proven inline key authoritative when scheme discovery is incomplete", async () => {
    const root = await fixture({ includeKey: false, workspace: true });
    const inlineKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    const visibleSchemeKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenSchemeKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${inlineKey}")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    await fillProjectSchemeLimit(root, selectedTargetRunScheme(visibleSchemeKey));
    await writeWorkspaceRunScheme(
      root,
      "WorkspaceRuntime.xcscheme",
      selectedTargetRunScheme(hiddenSchemeKey, "MyApp.xcodeproj"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toMatchObject({
      evidenceComplete: true,
      found: true,
      conflict: false,
      source: "MyApp/MyAppApp.swift",
      frontendApiHost: "inline.clerk.example",
    });
    expect(
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "xcode.incomplete-scheme-discovery",
      ),
    ).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain(inlineKey);
    expect(JSON.stringify(inspection)).not.toContain(visibleSchemeKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenSchemeKey);
  });

  test("fails incomplete scheme discovery closed when inline startup wiring is ambiguous", async () => {
    const root = await fixture({ includeKey: false, workspace: true });
    const inlineKey = `pk_test_${Buffer.from("inline.clerk.example$").toString("base64")}`;
    const visibleSchemeKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenSchemeKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${inlineKey}")
    Clerk.configure(publishableKey: "${inlineKey}")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    await fillProjectSchemeLimit(root, selectedTargetRunScheme(visibleSchemeKey));
    await writeWorkspaceRunScheme(
      root,
      "WorkspaceRuntime.xcscheme",
      selectedTargetRunScheme(hiddenSchemeKey, "MyApp.xcodeproj"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.swift.configureCalls).toHaveLength(2);
    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: false,
      found: false,
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/ZRuntime.xcscheme",
        "MyApp/MyAppApp.swift",
      ],
      invalidSources: [],
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-scheme-discovery" }),
    );
    expect(JSON.stringify(inspection)).not.toContain(inlineKey);
    expect(JSON.stringify(inspection)).not.toContain(visibleSchemeKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenSchemeKey);
  });

  test("keeps a proven LocalSecrets key authoritative when scheme discovery is incomplete", async () => {
    const root = await fixture({
      complete: true,
      includeKey: false,
      localSecrets: true,
      workspace: true,
    });
    const visibleSchemeKey = `pk_test_${Buffer.from("visible.clerk.example$").toString("base64")}`;
    const hiddenSchemeKey = `pk_test_${Buffer.from("hidden.clerk.example$").toString("base64")}`;
    await fillProjectSchemeLimit(root, selectedTargetRunScheme(visibleSchemeKey));
    await writeWorkspaceRunScheme(
      root,
      "WorkspaceRuntime.xcscheme",
      selectedTargetRunScheme(hiddenSchemeKey, "MyApp.xcodeproj"),
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toMatchObject({
      evidenceComplete: true,
      found: true,
      conflict: false,
      source: "MyApp/LocalSecrets.plist",
      frontendApiHost: "native.clerk.example",
    });
    expect(
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "xcode.incomplete-scheme-discovery",
      ),
    ).toBe(false);
    expect(
      inspection.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "clerk.unconsumed-publishable-key-source" &&
          diagnostic.message.includes("LocalSecrets.plist"),
      ),
    ).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain(visibleSchemeKey);
    expect(JSON.stringify(inspection)).not.toContain(hiddenSchemeKey);
  });

  test("uses the LocalSecrets key proven by app-init wiring instead of a different scheme key", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const schemeKey = `pk_test_${Buffer.from("scheme.clerk.example$").toString("base64")}`;
    const localSecretsKey = `pk_live_${Buffer.from("native.clerk.example$").toString("base64")}`;
    await writeSelectedTargetRunSchemeKey(root, schemeKey);

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: true,
      source: "MyApp/LocalSecrets.plist",
      frontendApiHost: "native.clerk.example",
      instanceType: "production",
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
      ],
      invalidSources: [],
    });
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
    expect(JSON.stringify(inspection)).not.toContain(localSecretsKey);
  });

  test("does not fall through from a malformed LocalSecrets key proven by app-init wiring", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const schemeKey = `pk_test_${Buffer.from("scheme.clerk.example$").toString("base64")}`;
    const malformedLocalSecretsKey = "pk_live_local-secret-must-not-leak";
    await writeSelectedTargetRunSchemeKey(root, schemeKey);
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>${malformedLocalSecretsKey}</string></dict></plist>`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: false,
      source: "MyApp/LocalSecrets.plist",
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
      ],
      invalidSources: ["MyApp/LocalSecrets.plist"],
    });
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
    expect(JSON.stringify(inspection)).not.toContain(malformedLocalSecretsKey);
  });

  test("does not fall through from an empty LocalSecrets handoff to a stale scheme key", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const schemeKey = `pk_test_${Buffer.from("stale-scheme.clerk.example$").toString("base64")}`;
    await writeSelectedTargetRunSchemeKey(root, schemeKey);
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: false,
      conflict: false,
      candidateSources: ["MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme"],
      invalidSources: [],
    });
    expect(
      inspection.diagnostics.some(
        (diagnostic) => diagnostic.code === "clerk.invalid-publishable-key",
      ),
    ).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
  });

  test("uses the selected target's scheme when app-init reads ProcessInfo", async () => {
    const root = await fixture({ includeKey: false, localSecrets: true });
    const schemeKey = `pk_test_${Buffer.from("scheme-runtime.clerk.example$").toString("base64")}`;
    const localSecretsKey = `pk_live_${Buffer.from("native.clerk.example$").toString("base64")}`;
    await writeSelectedTargetRunSchemeKey(root, schemeKey);
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["CLERK_PUBLISHABLE_KEY"] ?? "")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: true,
      source: "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
      frontendApiHost: "scheme-runtime.clerk.example",
      instanceType: "development",
      conflict: false,
      candidateSources: [
        "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
        "MyApp/LocalSecrets.plist",
      ],
      invalidSources: [],
    });
    expect(
      inspection.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "clerk.unconsumed-publishable-key-source" &&
          diagnostic.message.includes("Run-scheme key"),
      ),
    ).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain(schemeKey);
    expect(JSON.stringify(inspection)).not.toContain(localSecretsKey);
  });

  test("does not synthesize Run scheme markup across XML comments", async () => {
    const root = await fixture({ includeKey: false });
    const schemeDirectory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
    await mkdir(schemeDirectory, { recursive: true });
    const schemeKey = `pk_test_${Buffer.from("comment.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(schemeDirectory, "MyApp.xcscheme"),
      `<Scheme><Launch<!-- -->Action><BuildableProductRunnable><BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" /></BuildableProductRunnable><EnvironmentVariables><EnvironmentVariable key="CLERK_PUBLISHABLE_KEY" value="${schemeKey}" isEnabled="YES" /></EnvironmentVariables></Launch<!-- -->Action></Scheme>`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      evidenceComplete: true,
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
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
      evidenceComplete: true,
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
      evidenceComplete: true,
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
        evidenceComplete: true,
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
      evidenceComplete: true,
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
      evidenceComplete: true,
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
        evidenceComplete: true,
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
