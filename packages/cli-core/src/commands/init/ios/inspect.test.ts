import { afterEach, describe, expect, test } from "bun:test";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, truncate } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { discoverIOSContainers, inspectWorkspace } from "./discovery.ts";
import { inspectIOSProject, inspectIOSSourceMembership } from "./inspect.ts";
import { recoverIOSFileTransactions } from "./file-transaction.ts";
import type { PbxObject, PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const FILE_TRANSACTION_MODULE = `${import.meta.dir}/file-transaction.ts`;
const INSPECT_MODULE = `${import.meta.dir}/inspect.ts`;
const DISCOVERY_MODULE = `${import.meta.dir}/discovery.ts`;

async function runBoundedInspectionChild(source: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ status: "exited" as const, exitCode })),
    new Promise<{ status: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), 3_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome.status === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error("iOS inspection blocked while reading a non-regular file");
  }

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (outcome.exitCode !== 0) {
    throw new Error(`iOS inspection child failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

function createFIFO(path: string): void {
  const result = Bun.spawnSync(["mkfifo", path], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`Could not create FIFO: ${result.stderr.toString().trim()}`);
  }
}

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
  test("marks malformed source-membership collections incomplete while preserving valid owners", async () => {
    const root = await fixture({ complete: true, secondTarget: true });
    await transformProject(root, (objects) => {
      objects[IOS_FIXTURE_IDS.secondTarget]!.buildPhases = IOS_FIXTURE_IDS.secondSourcesPhase;
      objects[IOS_FIXTURE_IDS.secondSourcesPhase]!.files = IOS_FIXTURE_IDS.secondSourceBuildFile;
      objects[IOS_FIXTURE_IDS.secondSourceBuildFile]!.fileRef = IOS_FIXTURE_IDS.appFile;
    });

    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const memberships = await inspectIOSSourceMembership(root);
    const owners = memberships.filter((membership) =>
      membership.files.some((file) => file.relativePath === "MyApp/MyAppApp.swift"),
    );
    const secondMembership = owners.find(
      (membership) => membership.targetId === IOS_FIXTURE_IDS.secondTarget,
    );

    expect(owners).toHaveLength(2);
    expect(secondMembership).toMatchObject({ complete: false });
    expect(inspection.appTargets[0]?.swift.evidenceComplete).toBe(true);
  });

  test.each([
    ["a scalar", "616161616161616161616161"],
    ["a partially malformed array", ["616161616161616161616161", {}]],
  ])(
    "marks %s synchronized-group collection incomplete while preserving valid members",
    async (_description, synchronizedGroups) => {
      const root = await fixture({ complete: true });
      const synchronizedRootId = "616161616161616161616161";
      await mkdir(join(root, "Synced"));
      await Bun.write(
        join(root, "Synced", "SyncedApp.swift"),
        'import SwiftUI\n\n@main\nstruct SyncedApp: App {\n  var body: some Scene { WindowGroup { Text("Synced") } }\n}\n',
      );
      await transformProject(root, (objects) => {
        objects[synchronizedRootId] = {
          isa: "PBXFileSystemSynchronizedRootGroup",
          path: "Synced",
          sourceTree: "<group>",
        };
        objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = synchronizedGroups;
      });

      const inspection = await inspectIOSProject(root);
      const memberships = await inspectIOSSourceMembership(root);
      const target = inspection.appTargets[0];
      const membership = memberships.find(
        (candidate) => candidate.targetId === IOS_FIXTURE_IDS.appTarget,
      );

      expect(target?.swift.sourceFilesScanned).toBe(2);
      expect(target?.swift.entryPoints).toContainEqual({ path: "Synced/SyncedApp.swift" });
      expect(target?.swift.evidenceComplete).toBe(false);
      expect(membership?.files).toContainEqual({
        absolutePath: join(root, "Synced", "SyncedApp.swift"),
        relativePath: "Synced/SyncedApp.swift",
      });
      expect(membership?.complete).toBe(false);
      expect(inspection.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "xcode.incomplete-source-membership",
          severity: "info",
          evidence: [
            {
              path: "MyApp.xcodeproj/project.pbxproj",
              objectId: IOS_FIXTURE_IDS.appTarget,
            },
          ],
        }),
      );
    },
  );

  test.each([
    ["a scalar group exception", "717171717171717171717171", ["Excluded.swift"]],
    ["partially malformed group exceptions", ["717171717171717171717171", {}], ["Excluded.swift"]],
    ["a scalar membership exception", ["717171717171717171717171"], "Excluded.swift"],
    [
      "partially malformed membership exceptions",
      ["717171717171717171717171"],
      ["Excluded.swift", {}],
    ],
  ])(
    "marks %s incomplete while preserving valid synchronized exclusions",
    async (_description, groupExceptions, membershipExceptions) => {
      const root = await fixture({ complete: true });
      const synchronizedRootId = "616161616161616161616161";
      const exceptionId = "717171717171717171717171";
      await mkdir(join(root, "Synced"));
      await Bun.write(
        join(root, "Synced", "Included.swift"),
        "import ClerkKit\nstruct Included {}\n",
      );
      await Bun.write(
        join(root, "Synced", "Excluded.swift"),
        "import ClerkKit\nstruct Excluded {}\n",
      );
      await transformProject(root, (objects) => {
        objects[synchronizedRootId] = {
          isa: "PBXFileSystemSynchronizedRootGroup",
          exceptions: groupExceptions,
          path: "Synced",
          sourceTree: "<group>",
        };
        objects[exceptionId] = {
          isa: "PBXFileSystemSynchronizedBuildFileExceptionSet",
          membershipExceptions,
          target: IOS_FIXTURE_IDS.appTarget,
        };
        objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
      });

      const inspection = await inspectIOSProject(root);
      const memberships = await inspectIOSSourceMembership(root);
      const target = inspection.appTargets[0];
      const membership = memberships.find(
        (candidate) => candidate.targetId === IOS_FIXTURE_IDS.appTarget,
      );
      const synchronizedSources = membership?.files
        .map((file) => file.relativePath)
        .filter((path) => path.startsWith("Synced/"));

      expect(target?.swift.evidenceComplete).toBe(false);
      expect(membership?.complete).toBe(false);
      expect(synchronizedSources).toEqual(["Synced/Included.swift"]);
      expect(inspection.diagnostics).toContainEqual(
        expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
      );
    },
  );

  test.each([
    ["a missing exception record", undefined],
    ["an unknown exception record", { isa: "PBXFutureSynchronizedExceptionSet" }],
    [
      "an exception record with an unusable target selector",
      {
        isa: "PBXFileSystemSynchronizedBuildFileExceptionSet",
        membershipExceptions: ["Excluded.swift"],
        target: {},
      },
    ],
    [
      "an exception record with an unusable build-phase selector",
      {
        isa: "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet",
        buildPhase: {},
        membershipExceptions: ["Excluded.swift"],
      },
    ],
  ] as Array<[string, PbxObject | undefined]>)(
    "marks %s incomplete",
    async (_description, exceptionRecord) => {
      const root = await fixture({ complete: true });
      const synchronizedRootId = "616161616161616161616161";
      const exceptionId = "717171717171717171717171";
      await mkdir(join(root, "Synced"));
      await Bun.write(
        join(root, "Synced", "Included.swift"),
        "import ClerkKit\nstruct Included {}\n",
      );
      await transformProject(root, (objects) => {
        objects[synchronizedRootId] = {
          isa: "PBXFileSystemSynchronizedRootGroup",
          exceptions: [exceptionId],
          path: "Synced",
          sourceTree: "<group>",
        };
        if (exceptionRecord) objects[exceptionId] = exceptionRecord;
        objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
      });

      const inspection = await inspectIOSProject(root);
      const memberships = await inspectIOSSourceMembership(root);
      const target = inspection.appTargets[0];
      const membership = memberships.find(
        (candidate) => candidate.targetId === IOS_FIXTURE_IDS.appTarget,
      );

      expect(target?.swift.evidenceComplete).toBe(false);
      expect(membership?.complete).toBe(false);
      expect(membership?.files).toContainEqual({
        absolutePath: join(root, "Synced", "Included.swift"),
        relativePath: "Synced/Included.swift",
      });
      expect(inspection.diagnostics).toContainEqual(
        expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
      );
    },
  );

  test.each([
    ["a non-record synchronized platform-filter map", ["Included.swift"]],
    [
      "a synchronized platform-filter map with malformed entries",
      { "Included.swift": ["macos", {}] },
    ],
  ])("marks %s incomplete", async (_description, filtersByPath) => {
    const root = await fixture({ complete: true });
    const synchronizedRootId = "616161616161616161616161";
    const exceptionId = "717171717171717171717171";
    await mkdir(join(root, "Synced"));
    await Bun.write(
      join(root, "Synced", "Included.swift"),
      "import ClerkKit\nstruct Included {}\n",
    );
    await Bun.write(
      join(root, "Synced", "Excluded.swift"),
      "import ClerkKit\nstruct Excluded {}\n",
    );
    await transformProject(root, (objects) => {
      objects[synchronizedRootId] = {
        isa: "PBXFileSystemSynchronizedRootGroup",
        exceptions: [exceptionId],
        path: "Synced",
        sourceTree: "<group>",
      };
      objects[exceptionId] = {
        isa: "PBXFileSystemSynchronizedBuildFileExceptionSet",
        membershipExceptions: ["Excluded.swift"],
        platformFiltersByRelativePath: filtersByPath,
        target: IOS_FIXTURE_IDS.appTarget,
      };
      objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
    });

    const inspection = await inspectIOSProject(root);
    const memberships = await inspectIOSSourceMembership(root);
    const target = inspection.appTargets[0];
    const membership = memberships.find(
      (candidate) => candidate.targetId === IOS_FIXTURE_IDS.appTarget,
    );
    const synchronizedSources = membership?.files
      .map((file) => file.relativePath)
      .filter((path) => path.startsWith("Synced/"));

    expect(target?.swift.evidenceComplete).toBe(false);
    expect(membership?.complete).toBe(false);
    expect(synchronizedSources).toEqual(["Synced/Included.swift"]);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
    );
  });

  test("ignores a valid synchronized exception for another target", async () => {
    const root = await fixture({ complete: true });
    const synchronizedRootId = "616161616161616161616161";
    const exceptionId = "717171717171717171717171";
    await mkdir(join(root, "Synced"));
    await Bun.write(
      join(root, "Synced", "Included.swift"),
      "import ClerkKit\nstruct Included {}\n",
    );
    await transformProject(root, (objects) => {
      objects[synchronizedRootId] = {
        isa: "PBXFileSystemSynchronizedRootGroup",
        exceptions: [exceptionId],
        path: "Synced",
        sourceTree: "<group>",
      };
      objects[exceptionId] = {
        isa: "PBXFileSystemSynchronizedBuildFileExceptionSet",
        membershipExceptions: ["Included.swift"],
        target: "818181818181818181818181",
      };
      objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
    });

    const inspection = await inspectIOSProject(root);
    const target = inspection.appTargets[0];

    expect(target?.swift.evidenceComplete).toBe(true);
    expect(target?.swift.entryPoints).not.toEqual([]);
    expect(target?.swift.sourceFilesScanned).toBe(2);
    expect(inspection.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
    );
  });

  test("marks source membership incomplete when a group-relative file has multiple parents", async () => {
    const root = await fixture({ complete: true });
    const alternateGroupId = "565656565656565656565656";
    await mkdir(join(root, "Alternate"));
    await Bun.write(
      join(root, "Alternate", "MyAppApp.swift"),
      'import SwiftUI\n\n@main\nstruct AlternateApp: App {\n  var body: some Scene { WindowGroup { Text("Alternate") } }\n}\n',
    );
    await transformProject(root, (objects) => {
      const appGroup = objects[IOS_FIXTURE_IDS.appGroup]!;
      delete objects[IOS_FIXTURE_IDS.appGroup];
      objects[alternateGroupId] = {
        isa: "PBXGroup",
        children: [IOS_FIXTURE_IDS.appFile],
        path: "Alternate",
        sourceTree: "<group>",
      };
      objects[IOS_FIXTURE_IDS.appGroup] = appGroup;
      objects[IOS_FIXTURE_IDS.mainGroup]!.children = [
        alternateGroupId,
        ...((objects[IOS_FIXTURE_IDS.mainGroup]!.children as string[]) ?? []),
      ];
    });

    const inspection = await inspectIOSProject(root);
    const memberships = await inspectIOSSourceMembership(root);
    const appMembership = memberships.find(
      (membership) => membership.targetId === IOS_FIXTURE_IDS.appTarget,
    );

    expect(inspection.appTargets[0]?.swift.evidenceComplete).toBe(false);
    expect(inspection.appTargets[0]?.swift.sourceFilesScanned).toBe(0);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
    );
    expect(appMembership).toMatchObject({ complete: false, files: [] });
  });

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
    expect(inspection.localPublishableKey).toEqual({
      state: "unproven",
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

  test("extracts the App ID Prefix when Bundle ID casing differs", async () => {
    const root = await fixture({ complete: true });
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    const entitlements = await readFile(entitlementsPath, "utf8");
    await Bun.write(
      entitlementsPath,
      entitlements.replace("LEGACY1234.com.example.MyApp", "LEGACY1234.COM.EXAMPLE.MYAPP"),
    );

    const inspection = await inspectIOSProject(root);

    expect(
      inspection.appTargets[0]?.configurations.map(
        (configuration) => configuration.entitlements?.literalAppIdentifierPrefix,
      ),
    ).toEqual(["LEGACY1234", "LEGACY1234"]);
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

  test("rejects an entitlements FIFO without blocking inspection", async () => {
    if (process.platform === "win32") return;
    const root = await fixture({ complete: true });
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    await rm(entitlementsPath);
    createFIFO(entitlementsPath);

    const output = await runBoundedInspectionChild(`
        const { inspectIOSProject } = await import(${JSON.stringify(INSPECT_MODULE)});
        const result = await inspectIOSProject(${JSON.stringify(root)});
        console.log(JSON.stringify(result.diagnostics.map((diagnostic) => diagnostic.code)));
      `);

    expect(JSON.parse(output)).toContain("xcode.unreadable-entitlements");
  }, 10_000);

  test("rejects oversized entitlements before loading their bytes", async () => {
    const root = await fixture({ complete: true });
    await truncate(join(root, "MyApp", "MyApp.entitlements"), 2_000_001);

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toBeUndefined();
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.unreadable-entitlements" }),
    );
  });

  test("rejects malformed Associated Domains entries instead of filtering them", async () => {
    const root = await fixture({ complete: true });
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    const entitlements = await Bun.file(entitlementsPath).text();
    await Bun.write(
      entitlementsPath,
      entitlements.replace(
        "<string>webcredentials:clerk.example.test</string>",
        "<string>webcredentials:clerk.example.test</string><true/>",
      ),
    );
    await addAppleEntitlement(root, "<array><string>Default</string></array>");

    const inspection = await inspectIOSProject(root);

    expect(inspection.appTargets[0]?.configurations[0]?.entitlements).toMatchObject({
      associatedDomains: [],
      signInWithAppleState: "exact",
      signInWithApple: true,
    });
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.invalid-associated-domains",
        message: expect.stringContaining("invalid Associated Domains"),
      }),
    );
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

  test.each([
    ["decimal", "group:MyApp&#46;xcodeproj"],
    ["hexadecimal", "group:MyApp&#x2E;xcodeproj"],
  ])("decodes %s numeric entities in workspace locations", async (_label, location) => {
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      `<Workspace version="1.0"><FileRef location="${location}"></FileRef></Workspace>`,
    );

    const result = await inspectWorkspace(root, workspace);

    expect(result.inspection.projectPaths).toEqual(["MyApp.xcodeproj"]);
    expect(result.localProjectPaths).toEqual([join(root, "MyApp.xcodeproj")]);
  });

  test.each(["&#0;", "&#xD800;", "&#1114112;", "&#x110000;"])(
    "rejects invalid XML code point %s in a workspace location",
    async (reference) => {
      const root = await fixture({ workspace: true });
      const workspace = join(root, "MyApp.xcworkspace");
      await Bun.write(
        join(workspace, "contents.xcworkspacedata"),
        `<Workspace version="1.0"><FileRef location="group:MyApp${reference}.xcodeproj"></FileRef></Workspace>`,
      );

      const result = await inspectWorkspace(root, workspace);

      expect(result.inspection.projectPaths).toEqual([]);
      expect(result.localProjectPaths).toEqual([]);
    },
  );

  test("does not decode numeric syntax introduced by an escaped ampersand", async () => {
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      '<Workspace version="1.0"><FileRef location="group:MyApp&amp;#46;xcodeproj"></FileRef></Workspace>',
    );

    const result = await inspectWorkspace(root, workspace);

    expect(result.inspection.projectPaths).toEqual([]);
    expect(result.localProjectPaths).toEqual([]);
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

  test("rejects a workspace metadata FIFO without blocking inspection", async () => {
    if (process.platform === "win32") return;
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    const contentsPath = join(workspace, "contents.xcworkspacedata");
    await rm(contentsPath);
    createFIFO(contentsPath);

    const output = await runBoundedInspectionChild(`
        const { inspectWorkspace } = await import(${JSON.stringify(DISCOVERY_MODULE)});
        const result = await inspectWorkspace(${JSON.stringify(root)}, ${JSON.stringify(workspace)});
        console.log(JSON.stringify(result));
      `);

    expect(JSON.parse(output)).toEqual({
      inspection: { path: "MyApp.xcworkspace", projectPaths: [] },
      localProjectPaths: [],
    });
  }, 10_000);

  test("rejects oversized workspace metadata before loading its bytes", async () => {
    const root = await fixture({ workspace: true });
    const workspace = join(root, "MyApp.xcworkspace");
    await truncate(join(workspace, "contents.xcworkspacedata"), 2_000_001);

    const result = await inspectWorkspace(root, workspace);

    expect(result).toEqual({
      inspection: { path: "MyApp.xcworkspace", projectPaths: [] },
      localProjectPaths: [],
    });
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
      state: "valid",
      source: "MyApp/MyAppApp.swift",
      frontendApiHost: "inline.clerk.example",
      instanceType: "development",
    });
    expect(JSON.stringify(inspection)).not.toContain(publishableKey);
  });

  test("does not fall through from an invalid app-init literal to other key sources", async () => {
    const root = await fixture({ includeKey: false });
    const invalidInlineKey = "pk_test_inline-secret-must-not-leak";
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
      state: "invalid",
      source: "MyApp/MyAppApp.swift",
    });
    expect(JSON.stringify(inspection)).not.toContain(invalidInlineKey);
  });

  test("marks multiple valid configure calls as unproven instead of invalid", async () => {
    const root = await fixture({ includeKey: false });
    const startupKey = `pk_test_${Buffer.from("startup.clerk.example$").toString("base64")}`;
    const deferredKey = `pk_test_${Buffer.from("deferred.clerk.example$").toString("base64")}`;
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${startupKey}") }

  var body: some Scene { WindowGroup { Text("Hello") } }

  func configureAgain() {
    Clerk.configure(publishableKey: "${deferredKey}")
  }
}
`,
    );

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({ state: "unproven" });
    expect(JSON.stringify(inspection)).not.toContain(startupKey);
    expect(JSON.stringify(inspection)).not.toContain(deferredKey);
  });

  test("does not treat web-framework key names as native iOS configuration", async () => {
    const root = await fixture({ includeKey: false });
    const webKey = `pk_test_${Buffer.from("web.clerk.example$").toString("base64")}`;
    await Bun.write(join(root, ".env"), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${webKey}\n`);

    const inspection = await inspectIOSProject(root);

    expect(inspection.localPublishableKey).toEqual({
      state: "missing",
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

  test.each([
    ["a scalar", "futureos"],
    ["a partially malformed array", "( ios, 1, )"],
  ])(
    "does not use %s platformFilters value as authoritative iOS evidence",
    async (_description, platformFilters) => {
      const root = await fixture({ complete: true });
      const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
      const original = await Bun.file(projectFile).text();
      await Bun.write(
        projectFile,
        original
          .replace(
            `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef`,
            `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; platformFilters = ${platformFilters}; fileRef`,
          )
          .replace(
            `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; productRef`,
            `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; platformFilters = ${platformFilters}; productRef`,
          ),
      );

      const inspection = await inspectIOSProject(root);
      const target = inspection.appTargets[0];

      expect(target?.swift.sourceFilesScanned).toBe(0);
      expect(target?.swift.evidenceComplete).toBe(false);
      expect(target?.packages.clerkKit).toBe("declared");
    },
  );

  test.each([
    ["an array", "( ios, )"],
    ["an object", "{ value = ios; }"],
  ])(
    "does not use %s platformFilter value as authoritative iOS evidence",
    async (_description, platformFilter) => {
      const root = await fixture({ complete: true });
      const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
      const original = await Bun.file(projectFile).text();
      await Bun.write(
        projectFile,
        original
          .replace(
            `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef`,
            `${IOS_FIXTURE_IDS.sourceBuildFile} = { isa = PBXBuildFile; platformFilter = ${platformFilter}; fileRef`,
          )
          .replace(
            `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; productRef`,
            `${IOS_FIXTURE_IDS.clerkKitBuildFile} = { isa = PBXBuildFile; platformFilter = ${platformFilter}; productRef`,
          ),
      );

      const inspection = await inspectIOSProject(root);
      const target = inspection.appTargets[0];

      expect(target?.swift.sourceFilesScanned).toBe(0);
      expect(target?.swift.evidenceComplete).toBe(false);
      expect(target?.packages.clerkKit).toBe("declared");
      expect(inspection.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "xcode.incomplete-source-membership",
          severity: "info",
        }),
      );
    },
  );

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

  test("rejects a project metadata FIFO without blocking inspection", async () => {
    if (process.platform === "win32") return;
    const root = await fixture({ complete: true });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await rm(projectPath);
    createFIFO(projectPath);

    const output = await runBoundedInspectionChild(`
        const { inspectIOSProject } = await import(${JSON.stringify(INSPECT_MODULE)});
        const result = await inspectIOSProject(${JSON.stringify(root)});
        console.log(JSON.stringify(result.diagnostics.map((diagnostic) => diagnostic.code)));
      `);

    expect(JSON.parse(output)).toContain("xcode.malformed-project");
  }, 10_000);

  test("rejects oversized project metadata before loading its bytes", async () => {
    const root = await fixture({ complete: true });
    await truncate(join(root, "MyApp.xcodeproj", "project.pbxproj"), 15_000_001);

    const inspection = await inspectIOSProject(root);

    expect(inspection.selection.state).toBe("none");
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.malformed-project",
        message: expect.stringContaining("too large"),
      }),
    );
  });

  test("detects generated projects and never mutates the inspected tree", async () => {
    const root = await fixture({ complete: true, generated: "xcodegen" });
    const before = await treeDigest(root);

    const inspection = await inspectIOSProject(root);

    expect(inspection.generatedProject).toBe("xcodegen");
    expect(await treeDigest(root)).toEqual(before);
  });
});
