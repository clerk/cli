import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectIOSProject } from "../init/ios/inspect.ts";
import { createIOSFixture, IOS_FIXTURE_IDS } from "../init/ios/test-helpers.ts";
import {
  createIOSXcodeChildEnvironment,
  runIOSXcodeCommand,
  runIOSXcodeVerification,
  sanitizeIOSXcodeDiagnostic,
  type IOSXcodeCommandOptions,
  type IOSXcodeCommandResult,
  type IOSXcodeCommandRunner,
} from "./ios-xcode.ts";

interface Invocation {
  argv: string[];
  options: IOSXcodeCommandOptions;
}

const success = (stdout = "", stderr = ""): IOSXcodeCommandResult => ({
  exitCode: 0,
  stdout,
  stderr,
  timedOut: false,
  truncated: false,
});

const failure = (stderr: string): IOSXcodeCommandResult => ({
  exitCode: 65,
  stdout: "",
  stderr,
  timedOut: false,
  truncated: false,
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let root: string;
let temporaryBuildRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clerk-doctor-ios-xcode-test-"));
  temporaryBuildRoot = join(root, ".doctor-build");
  await mkdir(temporaryBuildRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function packageResolvedContents(): string {
  return JSON.stringify({
    version: 3,
    pins: [
      {
        identity: "clerk-ios",
        kind: "remoteSourceControl",
        location: "https://github.com/clerk/clerk-ios.git",
        state: { revision: "abc", version: "1.0.0" },
      },
    ],
  });
}

async function writeProjectPackageResolved(projectName = "MyApp"): Promise<string> {
  const path = join(
    root,
    `${projectName}.xcodeproj`,
    "project.xcworkspace",
    "xcshareddata",
    "swiftpm",
    "Package.resolved",
  );
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, packageResolvedContents());
  return path;
}

async function writeWorkspacePackageResolved(workspaceName = "MyApp"): Promise<string> {
  const path = join(
    root,
    `${workspaceName}.xcworkspace`,
    "xcshareddata",
    "swiftpm",
    "Package.resolved",
  );
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, packageResolvedContents());
  return path;
}

async function replaceClerkWithLocalPackage(remoteDependency: boolean): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const source = await Bun.file(projectPath).text();
  const remoteReference = `${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/clerk/clerk-ios.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };`;
  if (!source.includes(remoteReference)) throw new Error("Fixture remote package not found");
  await Bun.write(
    projectPath,
    source.replace(
      remoteReference,
      `${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCLocalSwiftPackageReference; relativePath = LocalClerk; };`,
    ),
  );

  const packageRoot = join(root, "LocalClerk");
  await mkdir(packageRoot, { recursive: true });
  const dependencies = remoteDependency
    ? '[.package(url: "https://example.com/remote.git", from: "1.0.0")]'
    : "[]";
  await Bun.write(
    join(packageRoot, "Package.swift"),
    `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "LocalClerk", products: [.library(name: "ClerkKit", targets: ["ClerkKit"])], dependencies: ${dependencies}, targets: [.target(name: "ClerkKit")])\n`,
  );
}

async function addSecondWorkspaceProjectWithRemotePackage(): Promise<void> {
  const nestedRoot = join(root, "Second");
  await createIOSFixture(nestedRoot, { includeKey: false });
  const projectPath = join(nestedRoot, "MyApp.xcodeproj", "project.pbxproj");
  const source = await Bun.file(projectPath).text();
  await Bun.write(
    projectPath,
    source.replace(`targets = ( ${IOS_FIXTURE_IDS.appTarget}, );`, "targets = ( );"),
  );
  await Bun.write(
    join(root, "MyApp.xcworkspace", "contents.xcworkspacedata"),
    '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef><FileRef location="group:Second/MyApp.xcodeproj"></FileRef></Workspace>',
  );
}

async function writeSharedScheme(name: string, xml: string): Promise<void> {
  const directory = join(root, "MyApp.xcodeproj", "xcshareddata", "xcschemes");
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, `${name}.xcscheme`), xml);
}

function buildSettingsOutput(
  options: {
    projectPath?: string;
    targetName?: string;
    productType?: string;
    bundleIdentifier?: string;
  } = {},
): string {
  const targetBuildDir = join(
    temporaryBuildRoot,
    "DerivedData",
    "Build",
    "Products",
    "Debug-iphonesimulator",
  );
  return JSON.stringify([
    {
      target: options.targetName ?? "MyApp",
      buildSettings: {
        TARGET_NAME: options.targetName ?? "MyApp",
        PROJECT_FILE_PATH: options.projectPath ?? join(root, "MyApp.xcodeproj"),
        PRODUCT_TYPE: options.productType ?? "com.apple.product-type.application",
        TARGET_BUILD_DIR: targetBuildDir,
        FULL_PRODUCT_NAME: "MyApp.app",
        PRODUCT_BUNDLE_IDENTIFIER: options.bundleIdentifier ?? "com.example.MyApp",
      },
    },
  ]);
}

function builtInfoPlist(bundleIdentifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string></dict></plist>`;
}

function successfulXcodeRunner(
  invocations: Invocation[],
  options: {
    schemes?: string[];
    workspace?: boolean;
    buildFailure?: string;
    createApp?: boolean;
    simulatorDevices?: unknown;
    buildSettingsBundleIdentifier?: string;
    artifactBundleIdentifier?: string;
    omitInfoPlist?: boolean;
    malformedInfoPlist?: boolean;
    infoPlistSymlinkTarget?: string;
  } = {},
): IOSXcodeCommandRunner {
  return async (argv, commandOptions) => {
    const args = [...argv];
    invocations.push({ argv: args, options: commandOptions });
    if (args.includes("-version")) return success("Xcode 26.0\nBuild version 1A1\n");
    if (args.includes("-resolvePackageDependencies")) return success();
    if (args.includes("-list") && args.includes("xcodebuild")) {
      const containerKind = args.includes("-workspace") ? "workspace" : "project";
      return success(
        JSON.stringify({
          [containerKind]: {
            schemes: options.schemes ?? ["MyApp"],
            targets: ["MyApp"],
            configurations: ["Debug", "Release"],
          },
        }),
      );
    }
    if (args.includes("-showBuildSettings")) {
      return success(
        buildSettingsOutput({ bundleIdentifier: options.buildSettingsBundleIdentifier }),
      );
    }
    if (args.includes("build") && args.includes("xcodebuild")) {
      if (options.buildFailure) return failure(options.buildFailure);
      if (options.createApp) {
        const appPath = join(
          temporaryBuildRoot,
          "DerivedData",
          "Build",
          "Products",
          "Debug-iphonesimulator",
          "MyApp.app",
        );
        await mkdir(appPath, { recursive: true });
        const infoPlistPath = join(appPath, "Info.plist");
        if (options.infoPlistSymlinkTarget) {
          await symlink(options.infoPlistSymlinkTarget, infoPlistPath);
        } else if (!options.omitInfoPlist) {
          await Bun.write(
            infoPlistPath,
            options.malformedInfoPlist
              ? "not a property list"
              : builtInfoPlist(options.artifactBundleIdentifier ?? "com.example.MyApp"),
          );
        }
      }
      return success();
    }
    if (args[0] === "/usr/bin/plutil") {
      return options.malformedInfoPlist
        ? failure("Info.plist could not be parsed")
        : success(options.artifactBundleIdentifier ?? "com.example.MyApp");
    }
    if (args.includes("simctl") && args.includes("list")) {
      return success(JSON.stringify(options.simulatorDevices));
    }
    if (args.includes("simctl")) return success();
    return failure(`Unexpected command: ${args.join(" ")}`);
  };
}

function dependencies(runner: IOSXcodeCommandRunner) {
  return {
    runner,
    platform: "darwin" as const,
    xcrunPath: "/usr/bin/xcrun",
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      USER: "tester",
      CLERK_PLATFORM_API_KEY: "ak_test_must_not_escape",
      CLERK_SECRET_KEY: "sk_test_must_not_escape",
      GITHUB_TOKEN: "github_must_not_escape",
    },
    makeTemporaryDirectory: async () => temporaryBuildRoot,
    removeTemporaryDirectory: async (path: string) => {
      await rm(path, { recursive: true, force: false });
    },
  };
}

describe("runIOSXcodeVerification", () => {
  test("uses a verified auto-created scheme for a frozen isolated build", async () => {
    await createIOSFixture(root);
    const lockPath = await writeProjectPackageResolved();
    const lockBefore = await Bun.file(lockPath).text();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations)),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(results.map((result) => result.name)).toEqual([
      "Xcode container",
      "Xcode toolchain",
      "Swift packages",
      "Xcode scheme",
      "Xcode build",
    ]);

    const hydrationIndex = invocations.findIndex((invocation) =>
      invocation.argv.includes("-resolvePackageDependencies"),
    );
    const listIndex = invocations.findIndex((invocation) => invocation.argv.includes("-list"));
    const hydration = invocations[hydrationIndex];
    expect(hydrationIndex).toBeGreaterThan(-1);
    expect(hydrationIndex).toBeLessThan(listIndex);
    expect(hydration?.argv).toContain("-disableAutomaticPackageResolution");
    expect(hydration?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
    expect(hydration?.argv).toContain("-skipPackageUpdates");
    expect(hydration?.argv).toContain(join(temporaryBuildRoot, "SourcePackages"));
    expect(await Bun.file(lockPath).text()).toBe(lockBefore);

    const packagePhases = invocations.filter(
      (invocation) =>
        invocation.argv.includes("xcodebuild") && !invocation.argv.includes("-version"),
    );
    expect(packagePhases).toHaveLength(4);
    for (const phase of packagePhases) {
      expect(phase.argv).toContain("-packageCachePath");
      expect(phase.argv).toContain(join(temporaryBuildRoot, "PackageCache"));
    }

    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).not.toContain("-project");
    const workspaceIndex = build?.argv.indexOf("-workspace") ?? -1;
    expect(workspaceIndex).toBeGreaterThan(-1);
    const isolatedWorkspace = build?.argv[workspaceIndex + 1];
    expect(isolatedWorkspace).toStartWith(join(root, ".clerk-doctor-"));
    expect(isolatedWorkspace).toEndWith(".xcworkspace");
    expect(isolatedWorkspace).not.toBe(join(root, "MyApp.xcworkspace"));
    expect(build?.argv).toContain("-scheme");
    expect(build?.argv).toContain("MyApp");
    expect(build?.argv).toContain("generic/platform=iOS Simulator");
    expect(build?.argv).toContain("-disableAutomaticPackageResolution");
    expect(build?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
    expect(build?.argv).toContain("-skipPackageUpdates");
    expect(build?.argv).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(build?.argv).toContain(join(temporaryBuildRoot, "DerivedData"));
    expect(build?.argv).toContain(join(temporaryBuildRoot, "SourcePackages"));

    for (const invocation of invocations) {
      expect(invocation.options.env.CLERK_PLATFORM_API_KEY).toBeUndefined();
      expect(invocation.options.env.CLERK_SECRET_KEY).toBeUndefined();
      expect(invocation.options.env.GITHUB_TOKEN).toBeUndefined();
      expect(JSON.stringify(invocation)).not.toContain("must_not_escape");
    }
    expect((await readdir(root)).some((entry) => entry.startsWith(".clerk-doctor-"))).toBe(false);
  });

  test("stops when locked-package hydration changes Package.resolved", async () => {
    await createIOSFixture(root);
    const lockPath = await writeProjectPackageResolved();
    const lockBefore = await Bun.file(lockPath).text();
    const lockIdentity = await lstat(lockPath);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        const workspaceIndex = argv.indexOf("-workspace");
        const isolatedWorkspace = argv[workspaceIndex + 1];
        if (!isolatedWorkspace) throw new Error("Missing isolated workspace");
        await Bun.write(
          join(isolatedWorkspace, "xcshareddata", "swiftpm", "Package.resolved"),
          packageResolvedContents().replace('"revision":"abc"', '"revision":"changed"'),
        );
        return success();
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("isolated Package.resolved");
    expect(invocations.some((invocation) => invocation.argv.includes("-list"))).toBe(false);
    expect(await Bun.file(lockPath).text()).toBe(lockBefore);
    const lockAfter = await lstat(lockPath);
    expect({ device: lockAfter.dev, inode: lockAfter.ino }).toEqual({
      device: lockIdentity.dev,
      inode: lockIdentity.ino,
    });
  });

  test("keeps the original workspace lock unchanged when frozen hydration rewrites its copy", async () => {
    await createIOSFixture(root, { workspace: true });
    const lockPath = await writeWorkspacePackageResolved();
    const lockBefore = await Bun.file(lockPath).text();
    const lockIdentity = await lstat(lockPath);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations, { workspace: true });
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        const workspaceIndex = argv.indexOf("-workspace");
        const isolatedWorkspace = argv[workspaceIndex + 1];
        if (!isolatedWorkspace) throw new Error("Missing isolated workspace");
        await Bun.write(
          join(isolatedWorkspace, "xcshareddata", "swiftpm", "Package.resolved"),
          packageResolvedContents().replace('"revision":"abc"', '"revision":"changed"'),
        );
        return success();
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("isolated Package.resolved");
    expect(await Bun.file(lockPath).text()).toBe(lockBefore);
    const lockAfter = await lstat(lockPath);
    expect({ device: lockAfter.dev, inode: lockAfter.ino }).toEqual({
      device: lockIdentity.dev,
      inode: lockIdentity.ino,
    });
  });

  test("reports but preserves a concurrent edit to the original package lock", async () => {
    await createIOSFixture(root);
    const lockPath = await writeProjectPackageResolved();
    const changedLock = packageResolvedContents().replace(
      '"revision":"abc"',
      '"revision":"concurrent"',
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    let changed = false;
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (!changed && argv.includes("-resolvePackageDependencies")) {
        changed = true;
        await Bun.write(lockPath, changedLock);
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("original Package.resolved became updated");
    expect(await Bun.file(lockPath).text()).toBe(changedLock);
  });

  test("reports locked-package hydration failures as Swift package failures", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        return failure(
          "xcodebuild: error: Could not resolve package dependencies: Couldn't check out revision 'abc'",
        );
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("Fetching locked Swift packages");
    expect(results.at(-1)?.remedy).toContain("network access");
    expect(results.at(-1)?.remedy).toContain("--resolve-packages");
    expect(invocations.some((invocation) => invocation.argv.includes("-list"))).toBe(false);
  });

  test("classifies package checkout failures during scheme discovery accurately", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-list")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        return failure("error: Couldn't fetch updates from remote repositories for clerk-ios");
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("during scheme discovery");
    expect(results.at(-1)?.remedy).toContain("package repositories");
  });

  test("classifies package checkout failures during a build accurately", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          buildFailure:
            "xcodebuild: error: Could not resolve package dependencies: Couldn't check out revision 'abc'",
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("during the build");
    expect(results.at(-1)?.remedy).toContain("package repositories");
  });

  test("does not classify an ordinary package-source compilation error as resolution failure", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const packageSource = join(
      temporaryBuildRoot,
      "SourcePackages",
      "checkouts",
      "clerk-ios",
      "Sources",
      "ClerkKit",
      "Session.swift",
    );

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          buildFailure: `${packageSource}:42:5: error: value of type 'Session' has no member 'invalid'`,
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "Xcode build", status: "fail" });
    expect(results.at(-1)?.message).toContain("iOS Simulator build");
    expect(results.at(-1)?.remedy).toContain("compilation error");
  });

  test("requires explicit package resolution before a remote-package build", async () => {
    await createIOSFixture(root);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations)),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.remedy).toContain("--resolve-packages --build");
    expect(invocations.some((invocation) => invocation.argv.includes("-list"))).toBe(false);
    expect(invocations.some((invocation) => invocation.argv.includes("build"))).toBe(false);
  });

  for (const workspace of [false, true]) {
    test(`requires explicit resolution for a local package with unknown transitive dependencies in a ${workspace ? "workspace" : "project"}`, async () => {
      await createIOSFixture(root, { workspace });
      await replaceClerkWithLocalPackage(true);
      const inspection = await inspectIOSProject(root, { target: "MyApp" });
      const invocations: Invocation[] = [];

      const results = await runIOSXcodeVerification(
        inspection,
        { build: true },
        dependencies(successfulXcodeRunner(invocations, { workspace })),
      );

      expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
      expect(results.at(-1)?.message).toContain("could not be proven local-only");
      expect(results.at(-1)?.remedy).toContain("--resolve-packages --build");
      expect(JSON.stringify(results)).not.toContain("No remote Swift package lock is required");
      expect(invocations).toEqual([]);
    });
  }

  test("includes a second inspected workspace project in package detection", async () => {
    await createIOSFixture(root, { clerkSDK: false, workspace: true });
    await addSecondWorkspaceProjectWithRemotePackage();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { workspace: true })),
    );

    expect(inspection.projects.map((project) => project.path)).toContain("Second/MyApp.xcodeproj");
    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("Remote Swift packages");
    expect(invocations).toEqual([]);
  });

  test("fails closed when a workspace contains an external non-project reference", async () => {
    await createIOSFixture(root, { clerkSDK: false, workspace: true });
    await Bun.write(
      join(root, "MyApp.xcworkspace", "contents.xcworkspacedata"),
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef><FileRef location="absolute:/private/tmp/ExternalPackage"></FileRef></Workspace>',
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { workspace: true })),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("could not be proven local-only");
    expect(invocations).toEqual([]);
  });

  test("ignores inspectable non-package workspace metadata", async () => {
    await createIOSFixture(root, { clerkSDK: false, workspace: true });
    await Bun.write(join(root, "README.md"), "# My app\n");
    await Bun.write(
      join(root, "MyApp.xcworkspace", "contents.xcworkspacedata"),
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef><FileRef location="group:README.md"></FileRef></Workspace>',
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { workspace: true })),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(results.find((result) => result.name === "Swift packages")?.message).toContain(
      "No remote Swift package lock is required",
    );
  });

  test("fails closed when workspace membership is incomplete", async () => {
    await createIOSFixture(root, { clerkSDK: false, workspace: true });
    await Bun.write(
      join(root, "MyApp.xcworkspace", "contents.xcworkspacedata"),
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef></Group></Workspace>',
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { workspace: true })),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("could not be proven local-only");
    expect(invocations).toEqual([]);
  });

  test("uses a valid lock for a local package with transitive remote dependencies", async () => {
    await createIOSFixture(root);
    await replaceClerkWithLocalPackage(true);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations)),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    const hydration = invocations.find((invocation) =>
      invocation.argv.includes("-resolvePackageDependencies"),
    );
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(hydration?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
    expect(build?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
  });

  test("switches a workspace local package to locked mode when resolution creates a lock", async () => {
    await createIOSFixture(root, { workspace: true });
    await replaceClerkWithLocalPackage(true);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations, { workspace: true });
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        await writeWorkspacePackageResolved();
        return success();
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true, build: true },
      dependencies(runner),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
  });

  test("continues with a proven local-only package when explicit resolution creates no lock", async () => {
    await createIOSFixture(root);
    await replaceClerkWithLocalPackage(false);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true, build: true },
      dependencies(successfulXcodeRunner(invocations)),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(results.find((result) => result.name === "Swift packages")?.message).toContain(
      "no remote package lock was produced",
    );
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).not.toContain("-onlyUsePackageVersionsFromResolvedFile");
  });

  test("uses a lock produced by explicit resolution when static inspection found no packages", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        await writeProjectPackageResolved();
        return success();
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true, build: true },
      dependencies(runner),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
  });

  test("resolves a direct workspace local package before building frozen", async () => {
    await createIOSFixture(root, { clerkSDK: false, workspace: true });
    await mkdir(join(root, "LocalPackage"), { recursive: true });
    await Bun.write(
      join(root, "LocalPackage", "Package.swift"),
      '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "LocalPackage", dependencies: [.package(url: "https://example.com/remote.git", from: "1.0.0")])\n',
    );
    await Bun.write(
      join(root, "MyApp.xcworkspace", "contents.xcworkspacedata"),
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef><FileRef location="group:LocalPackage"></FileRef></Workspace>',
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.projects.every((project) => project.packages.length === 0)).toBe(true);

    const blockedInvocations: Invocation[] = [];
    const blocked = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(blockedInvocations, { workspace: true })),
    );
    expect(blocked.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(blocked.at(-1)?.message).toContain("could not be proven local-only");
    expect(blockedInvocations).toEqual([]);

    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations, { workspace: true });
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        await writeWorkspacePackageResolved();
        return success();
      }
      return baseRunner(argv, commandOptions);
    };
    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true, build: true },
      dependencies(runner),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).toContain("-onlyUsePackageVersionsFromResolvedFile");
  });

  test("explicitly resolves packages, reports lockfile creation, then builds frozen", async () => {
    await createIOSFixture(root);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations);
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      if (argv.includes("-resolvePackageDependencies")) {
        invocations.push({ argv: [...argv], options: commandOptions });
        await writeProjectPackageResolved();
        return success();
      }
      return baseRunner(argv, commandOptions);
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true, build: true },
      dependencies(runner),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(results.find((result) => result.name === "Swift packages")?.message).toContain(
      "created",
    );
    const resolutionIndex = invocations.findIndex((invocation) =>
      invocation.argv.includes("-resolvePackageDependencies"),
    );
    const buildIndex = invocations.findIndex(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(resolutionIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(resolutionIndex);
    expect(invocations[resolutionIndex]?.argv).toContain("-packageCachePath");
    expect(invocations[resolutionIndex]?.argv).toContain(join(temporaryBuildRoot, "PackageCache"));
  });

  test("does not run Xcode when Package.resolved is a symbolic link", async () => {
    await createIOSFixture(root);
    const lockPath = join(
      root,
      "MyApp.xcodeproj",
      "project.xcworkspace",
      "xcshareddata",
      "swiftpm",
      "Package.resolved",
    );
    await mkdir(join(lockPath, ".."), { recursive: true });
    await symlink(join(tmpdir(), "clerk-doctor-external-Package.resolved"), lockPath);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { resolvePackages: true },
      dependencies(successfulXcodeRunner(invocations)),
    );

    expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
    expect(results.at(-1)?.message).toContain("unsafe to inspect or update");
    expect(invocations).toEqual([]);
  });

  test("does not run Xcode when a missing package lock has a symbolic-link ancestor", async () => {
    await createIOSFixture(root);
    const externalDirectory = await mkdtemp(join(tmpdir(), "clerk-doctor-lock-redirect-"));
    try {
      const workspacePath = join(root, "MyApp.xcodeproj", "project.xcworkspace");
      await mkdir(workspacePath, { recursive: true });
      await symlink(externalDirectory, join(workspacePath, "xcshareddata"), "dir");
      const inspection = await inspectIOSProject(root, { target: "MyApp" });
      const invocations: Invocation[] = [];

      const results = await runIOSXcodeVerification(
        inspection,
        { resolvePackages: true },
        dependencies(successfulXcodeRunner(invocations)),
      );

      expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
      expect(results.at(-1)?.message).toContain("unsafe to inspect or update");
      expect(invocations).toEqual([]);
    } finally {
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });

  test("does not read or run a frozen build through an external lockfile symlink", async () => {
    await createIOSFixture(root);
    const externalDirectory = await mkdtemp(join(tmpdir(), "clerk-doctor-lock-leaf-"));
    try {
      const externalLock = join(externalDirectory, "Package.resolved");
      await Bun.write(externalLock, packageResolvedContents());
      const lockPath = join(
        root,
        "MyApp.xcodeproj",
        "project.xcworkspace",
        "xcshareddata",
        "swiftpm",
        "Package.resolved",
      );
      await mkdir(join(lockPath, ".."), { recursive: true });
      await symlink(externalLock, lockPath);
      const inspection = await inspectIOSProject(root, { target: "MyApp" });
      const invocations: Invocation[] = [];

      const results = await runIOSXcodeVerification(
        inspection,
        { build: true },
        dependencies(successfulXcodeRunner(invocations)),
      );

      expect(results.at(-1)).toMatchObject({ name: "Swift packages", status: "fail" });
      expect(results.at(-1)?.message).toContain("unsafe to inspect or update");
      expect(invocations).toEqual([]);
    } finally {
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });

  test("does not read or run a frozen build through an external lock parent", async () => {
    await createIOSFixture(root);
    const externalDirectory = await mkdtemp(join(tmpdir(), "clerk-doctor-lock-parent-"));
    try {
      await mkdir(join(externalDirectory, "swiftpm"), { recursive: true });
      await Bun.write(
        join(externalDirectory, "swiftpm", "Package.resolved"),
        packageResolvedContents(),
      );
      const workspacePath = join(root, "MyApp.xcodeproj", "project.xcworkspace");
      await mkdir(workspacePath, { recursive: true });
      await symlink(externalDirectory, join(workspacePath, "xcshareddata"), "dir");
      const inspection = await inspectIOSProject(root, { target: "MyApp" });
      const invocations: Invocation[] = [];

      const results = await runIOSXcodeVerification(
        inspection,
        { build: true },
        dependencies(successfulXcodeRunner(invocations)),
      );

      expect(results.at(-1)).toMatchObject({
        name: "Swift packages",
        status: "fail",
      });
      expect(results.at(-1)?.detail).toContain("outside the inspected project root");
      expect(invocations).toEqual([]);
    } finally {
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });

  test("refuses to guess among unrelated schemes", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { schemes: ["Alpha", "Beta"] })),
    );

    expect(results.at(-1)).toMatchObject({ name: "Xcode scheme", status: "fail" });
    expect(results.at(-1)?.remedy).toContain("--scheme");
    expect(invocations.some((invocation) => invocation.argv.includes("-showBuildSettings"))).toBe(
      false,
    );
  });

  test("ignores a BuildableReference inside an XML comment", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    await writeSharedScheme(
      "Alpha",
      `<Scheme><BuildAction><!-- <BuildableReference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" ReferencedContainer="container:MyApp.xcodeproj" /> --></BuildAction></Scheme>`,
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { schemes: ["Alpha", "Beta"] })),
    );

    expect(results.at(-1)).toMatchObject({ name: "Xcode scheme", status: "fail" });
    expect(invocations.some((invocation) => invocation.argv.includes("-showBuildSettings"))).toBe(
      false,
    );
  });

  test("does not synthesize a BuildableReference across an XML comment", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    await writeSharedScheme(
      "Alpha",
      `<Scheme><BuildAction><Buildable<!-- -->Reference BlueprintIdentifier="${IOS_FIXTURE_IDS.appTarget}" ReferencedContainer="container:MyApp.xcodeproj" /></BuildAction></Scheme>`,
    );
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { schemes: ["Alpha", "Beta"] })),
    );

    expect(results.at(-1)).toMatchObject({ name: "Xcode scheme", status: "fail" });
    expect(invocations.some((invocation) => invocation.argv.includes("-showBuildSettings"))).toBe(
      false,
    );
  });

  test("uses the single containing workspace and its lockfile", async () => {
    await createIOSFixture(root, { workspace: true });
    await writeWorkspacePackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { workspace: true })),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    const build = invocations.find(
      (invocation) => invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
    );
    expect(build?.argv).toContain("-workspace");
    expect(build?.argv).not.toContain(join(root, "MyApp.xcworkspace"));
    const workspaceIndex = build?.argv.indexOf("-workspace") ?? -1;
    expect(build?.argv[workspaceIndex + 1]).toStartWith(join(root, ".clerk-doctor-"));
    expect((await readdir(root)).some((entry) => entry.startsWith(".clerk-doctor-"))).toBe(false);
  });

  test("sanitizes bounded Xcode failure diagnostics", async () => {
    await createIOSFixture(root);
    await writeProjectPackageResolved();
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const sensitive =
      "error: pk_test_publishable Bearer ak_test_platform CLERK_SECRET_KEY=sk_test_backend";

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      dependencies(successfulXcodeRunner(invocations, { buildFailure: sensitive })),
    );

    const output = JSON.stringify(results);
    expect(results.at(-1)).toMatchObject({ name: "Xcode build", status: "fail" });
    expect(output).not.toContain("pk_test_publishable");
    expect(output).not.toContain("ak_test_platform");
    expect(output).not.toContain("sk_test_backend");
    expect(output).toContain("<redacted>");
  });

  test("builds, installs, and launches on the single booted iOS simulator", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          {
            name: "iPhone 17 Pro",
            udid: "B926551C-01F4-4D5D-8CA8-90F2DF97C48A",
            state: "Booted",
            isAvailable: true,
          },
        ],
      },
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          simulatorDevices: devices,
        }),
      ),
    );

    expect(results.every((result) => result.status === "pass")).toBe(true);
    expect(results.at(-1)?.message).toContain("iPhone 17 Pro");
    const simulatorCommands = invocations
      .filter((invocation) => invocation.argv.includes("simctl"))
      .map((invocation) => invocation.argv);
    expect(simulatorCommands.map((argv) => argv[2])).toEqual([
      "list",
      "bootstatus",
      "install",
      "launch",
    ]);
    expect(simulatorCommands.flat()).not.toContain("--terminate-running-process");
    expect(simulatorCommands.flat()).not.toContain("--console");
    const plistInspection = invocations.find(
      (invocation) => invocation.argv[0] === "/usr/bin/plutil",
    );
    expect(plistInspection?.argv.slice(1, -1)).toEqual([
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-expect",
      "string",
      "-n",
      "--",
    ]);
    const install = simulatorCommands.find((argv) => argv[2] === "install");
    const plistPath = plistInspection?.argv.at(-1);
    const installPath = install?.at(-1);
    if (!plistPath || !installPath) throw new Error("Missing claimed application path");
    expect(dirname(plistPath)).toBe(installPath);
    expect(installPath).toContain(".clerk-doctor-built-");
    expect(simulatorCommands.at(-1)?.at(-1)).toBe("com.example.MyApp");
  });

  test("rejects whitespace in the verbatim built Info.plist Bundle ID", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          artifactBundleIdentifier: " com.example.MyApp ",
        }),
      ),
    );

    expect(
      results.find((result) => result.name === "iOS Simulator" && result.status === "fail"),
    ).toMatchObject({ message: "The built application's Info.plist has an invalid Bundle ID" });
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("preserves a built application replacement made during plist inspection", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations, { createApp: true });
    const movedApplication = join(temporaryBuildRoot, "plutil-original.app");
    let claimedApplicationPath: string | undefined;
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      const result = await baseRunner(argv, commandOptions);
      if (argv[0] === "/usr/bin/plutil") {
        const infoPlistPath = argv.at(-1);
        if (!infoPlistPath) throw new Error("Missing claimed Info.plist path");
        claimedApplicationPath = dirname(infoPlistPath);
        await rename(claimedApplicationPath, movedApplication);
        await mkdir(claimedApplicationPath);
        await Bun.write(
          join(claimedApplicationPath, "Info.plist"),
          builtInfoPlist("com.example.Replacement"),
        );
      }
      return result;
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(runner),
    );

    expect(
      results.find((result) => result.message.includes("changed during Bundle ID inspection")),
    ).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
    expect((await lstat(movedApplication)).isDirectory()).toBe(true);
    expect(await Bun.file(join(claimedApplicationPath!, "Info.plist")).text()).toContain(
      "com.example.Replacement",
    );
    expect(
      results.find(
        (result) =>
          result.name === "Xcode temporary files" &&
          result.message.includes("claimed simulator application"),
      ),
    ).toMatchObject({ status: "warn" });
  });

  test("preserves a built application replacement made during simulator installation", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const devices = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          {
            name: "iPhone 17 Pro",
            udid: "B926551C-01F4-4D5D-8CA8-90F2DF97C48A",
            state: "Booted",
            isAvailable: true,
          },
        ],
      },
    };
    const baseRunner = successfulXcodeRunner(invocations, {
      createApp: true,
      simulatorDevices: devices,
    });
    const movedApplication = join(temporaryBuildRoot, "install-original.app");
    let installPath: string | undefined;
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      const result = await baseRunner(argv, commandOptions);
      if (argv.includes("simctl") && argv.includes("install")) {
        installPath = argv.at(-1);
        if (!installPath) throw new Error("Missing claimed application install path");
        await rename(installPath, movedApplication);
        await mkdir(installPath);
        await Bun.write(join(installPath, "Info.plist"), builtInfoPlist("com.example.Replacement"));
      }
      return result;
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(runner),
    );

    expect(
      results.find((result) => result.message.includes("changed during installation")),
    ).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(
      invocations.some(
        (invocation) => invocation.argv.includes("simctl") && invocation.argv.includes("launch"),
      ),
    ).toBe(false);
    expect((await lstat(movedApplication)).isDirectory()).toBe(true);
    expect(await Bun.file(join(installPath!, "Info.plist")).text()).toContain(
      "com.example.Replacement",
    );
  });

  test("preserves a temporary build directory replacement created at cleanup", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const replacementPath = join(temporaryBuildRoot, "replacement.txt");
    const verificationDependencies = dependencies(successfulXcodeRunner(invocations));
    verificationDependencies.removeTemporaryDirectory = async (quarantinePath: string) => {
      await mkdir(temporaryBuildRoot);
      await Bun.write(replacementPath, "preserve me");
      await rm(quarantinePath, { recursive: true, force: false });
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { build: true },
      verificationDependencies,
    );

    expect(await Bun.file(replacementPath).text()).toBe("preserve me");
    expect(
      results.find(
        (result) =>
          result.name === "Xcode temporary files" &&
          result.message.includes("build directory could not be removed"),
      ),
    ).toMatchObject({ status: "warn" });
  });

  test("rejects a built Info.plist Bundle ID that differs from build settings", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          artifactBundleIdentifier: "com.example.OtherApp",
        }),
      ),
    );

    expect(results.find((result) => result.name === "Xcode build")?.status).toBe("pass");
    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("differs from Xcode's build settings");
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("rejects a built Info.plist Bundle ID that does not match the inspected target", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          buildSettingsBundleIdentifier: "com.example.OtherApp",
          artifactBundleIdentifier: "com.example.OtherApp",
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("does not match the inspected target");
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("fails closed when the built application has no Info.plist", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          omitInfoPlist: true,
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("Info.plist is missing or unsafe");
    expect(invocations.some((invocation) => invocation.argv[0] === "/usr/bin/plutil")).toBe(false);
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("fails closed when the built Info.plist is malformed", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          malformedInfoPlist: true,
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("Bundle ID inspection exited with code");
    expect(invocations.some((invocation) => invocation.argv[0] === "/usr/bin/plutil")).toBe(true);
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("rejects a symlinked built Info.plist", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const externalInfoPlist = join(root, "external-Info.plist");
    await Bun.write(externalInfoPlist, builtInfoPlist("com.example.MyApp"));
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(
        successfulXcodeRunner(invocations, {
          createApp: true,
          infoPlistSymlinkTarget: externalInfoPlist,
        }),
      ),
    );

    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("Info.plist is missing or unsafe");
    expect(invocations.some((invocation) => invocation.argv[0] === "/usr/bin/plutil")).toBe(false);
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("preserves a replacement that appears at the isolated-workspace cleanup boundary", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const invocations: Invocation[] = [];
    const baseRunner = successfulXcodeRunner(invocations, {
      createApp: true,
      simulatorDevices: {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            {
              name: "iPhone 17 Pro",
              udid: "B926551C-01F4-4D5D-8CA8-90F2DF97C48A",
              state: "Booted",
              isAvailable: true,
            },
          ],
        },
      },
    });
    const movedWorkspace = join(root, "doctor-owned-workspace-moved");
    const runner: IOSXcodeCommandRunner = async (argv, commandOptions) => {
      const result = await baseRunner(argv, commandOptions);
      if (argv.includes("simctl") && argv.includes("launch")) {
        const build = invocations.find(
          (invocation) =>
            invocation.argv.includes("xcodebuild") && invocation.argv.includes("build"),
        );
        const workspaceIndex = build?.argv.indexOf("-workspace") ?? -1;
        const isolatedWorkspace = build?.argv[workspaceIndex + 1];
        if (!isolatedWorkspace) throw new Error("Missing isolated workspace");
        await rename(isolatedWorkspace, movedWorkspace);
        await mkdir(isolatedWorkspace);
        await Bun.write(join(isolatedWorkspace, "replacement.txt"), "preserve me");
      }
      return result;
    };

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(runner),
    );

    expect(results.at(-1)).toMatchObject({
      name: "Xcode temporary files",
      status: "warn",
    });
    expect(results.at(-1)?.message).toContain("could not be removed safely");
    const cleanupEntry = (await readdir(root)).find((entry) =>
      entry.startsWith(".clerk-doctor-cleanup-"),
    );
    expect(cleanupEntry).toBeDefined();
    expect(results.at(-1)?.remedy).toContain("Inspect");
    expect(results.at(-1)?.remedy).toContain(join(root, cleanupEntry!));
    expect(results.at(-1)?.remedy).not.toContain("Remove");
    expect(await Bun.file(join(root, cleanupEntry!, "replacement.txt")).text()).toBe("preserve me");
  });

  test("builds but blocks simctl launch for a Run-scheme publishable key", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    const target = inspection.appTargets.find((candidate) => candidate.name === "MyApp")!;
    target.swift.configureCalls.push({
      path: "MyApp/MyAppApp.swift",
      publishableKeyWiring: "process-info-environment",
      startupBinding: "app-init",
    });
    const invocations: Invocation[] = [];

    const results = await runIOSXcodeVerification(
      inspection,
      { simulator: true },
      dependencies(successfulXcodeRunner(invocations, { createApp: true })),
    );

    expect(results.find((result) => result.name === "Xcode build")?.status).toBe("pass");
    expect(results.at(-1)).toMatchObject({ name: "iOS Simulator", status: "fail" });
    expect(results.at(-1)?.message).toContain("Run-scheme");
    expect(invocations.some((invocation) => invocation.argv.includes("simctl"))).toBe(false);
  });

  test("rejects --device unless simulator launch is requested", async () => {
    await createIOSFixture(root, { clerkSDK: false });
    const inspection = await inspectIOSProject(root, { target: "MyApp" });

    const results = await runIOSXcodeVerification(inspection, {
      build: true,
      device: "B926551C-01F4-4D5D-8CA8-90F2DF97C48A",
    });

    expect(results).toEqual([expect.objectContaining({ name: "iOS Simulator", status: "fail" })]);
  });
});

describe("Xcode subprocess safety", () => {
  test("redacts Clerk credentials, bearer tokens, and terminal controls", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      `${String.fromCharCode(27)}[31merror${String.fromCharCode(27)}[0m ` +
        "pk_test_public sk_live_backend Bearer ak_test_platform PASSWORD=hunter2",
    );

    expect(output).toContain("error");
    expect(output).not.toContain("pk_test_public");
    expect(output).not.toContain("sk_live_backend");
    expect(output).not.toContain("ak_test_platform");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain(String.fromCharCode(27));
  });

  test("redacts complete unquoted PEM private keys without hiding following output", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      [
        "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
        "unquoted-private-key-body",
        "another-private-key-line",
        "-----END PRIVATE KEY-----",
        "ordinary Xcode failure after the key",
      ].join("\n"),
    );

    expect(output).toContain("PRIVATE_KEY=<redacted>");
    expect(output).toContain("ordinary Xcode failure after the key");
    expect(output).not.toContain("BEGIN PRIVATE KEY");
    expect(output).not.toContain("unquoted-private-key-body");
    expect(output).not.toContain("another-private-key-line");
    expect(output).not.toContain("END PRIVATE KEY");
  });

  test("redacts complete quoted PEM private keys without hiding following output", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      [
        'PRIVATE_KEY="-----BEGIN PGP PRIVATE KEY BLOCK-----',
        "quoted-private-key-body",
        '-----END PGP PRIVATE KEY BLOCK-----"',
        "ordinary quoted-key failure",
      ].join("\n"),
    );

    expect(output).toContain("PRIVATE_KEY=<redacted>");
    expect(output).toContain("ordinary quoted-key failure");
    expect(output).not.toContain("BEGIN PGP PRIVATE KEY BLOCK");
    expect(output).not.toContain("quoted-private-key-body");
    expect(output).not.toContain("END PGP PRIVATE KEY BLOCK");
  });

  test("redacts unterminated PEM private keys through truncated output", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      [
        "PRIVATE_KEY='-----BEGIN OPENSSH PRIVATE KEY-----",
        "unterminated-private-key-body",
        "the diagnostic ended before the PEM footer",
      ].join("\n"),
    );

    expect(output).toBe("PRIVATE_KEY=<redacted>");
    expect(output).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(output).not.toContain("unterminated-private-key-body");
    expect(output).not.toContain("diagnostic ended");
  });

  test("redacts credentials embedded in HTTPS and SSH repository URLs", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      [
        "https://alice:https-secret@part@github.com/acme/private.git",
        "ssh://deploy:ssh-secret@git.example.com/acme/private.git",
        "git+ssh://builder:encoded%2Dsecret@git.example.com/acme/private.git",
        "machine:scp-secret@git.example.com:acme/private.git",
      ].join("\n"),
    );

    expect(output).toContain("https://<redacted>@github.com/acme/private.git");
    expect(output).toContain("ssh://<redacted>@git.example.com/acme/private.git");
    expect(output).toContain("git+ssh://<redacted>@git.example.com/acme/private.git");
    expect(output).toContain("<redacted>@git.example.com:acme/private.git");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("https-secret");
    expect(output).not.toContain("part");
    expect(output).not.toContain("ssh-secret");
    expect(output).not.toContain("encoded%2Dsecret");
    expect(output).not.toContain("scp-secret");
  });

  test("removes URL query and fragment secrets and Basic authorization payloads", () => {
    const output = sanitizeIOSXcodeDiagnostic(
      [
        "error cloning https://example.com/repo.git?key=supersecret",
        "fallback (ssh://git.example.com/acme/private.git#token=ssh-fragment).",
        "mirror git+ssh://git.example.com/acme/private.git?access_token=mirror-secret",
        "legacy git://git.example.com/acme/private.git#legacy-secret",
        "Authorization: Basic dXNlcjpwYXNz",
      ].join("\n"),
    );

    expect(output).toContain("https://example.com/repo.git");
    expect(output).toContain("(ssh://git.example.com/acme/private.git).");
    expect(output).toContain("git+ssh://git.example.com/acme/private.git");
    expect(output).toContain("git://git.example.com/acme/private.git");
    expect(output).toContain("Authorization: Basic <redacted>");
    expect(output).not.toContain("?key=");
    expect(output).not.toContain("#token=");
    expect(output).not.toContain("supersecret");
    expect(output).not.toContain("ssh-fragment");
    expect(output).not.toContain("mirror-secret");
    expect(output).not.toContain("legacy-secret");
    expect(output).not.toContain("dXNlcjpwYXNz");
  });

  test("passes only ordinary toolchain and locale environment values", () => {
    const env = createIOSXcodeChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      DEVELOPER_DIR: "/Applications/Xcode.app",
      CLERK_PLATFORM_API_KEY: "ak_test_secret",
      CLERK_SECRET_KEY: "sk_test_secret",
      GITHUB_TOKEN: "github_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      SIMCTL_CHILD_CLERK_PUBLISHABLE_KEY: "pk_test_secret",
      LC_API_KEY: "locale_api_secret",
      LC_TOKEN: "locale_token_secret",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      DEVELOPER_DIR: "/Applications/Xcode.app",
    });
    expect(env.LC_API_KEY).toBeUndefined();
    expect(env.LC_TOKEN).toBeUndefined();
  });

  test("bounds subprocess output while continuing to drain it", async () => {
    const script = join(root, "large-output.ts");
    await Bun.write(script, 'process.stdout.write("x".repeat(4096));\n');

    const result = await runIOSXcodeCommand([process.execPath, script], {
      cwd: root,
      env: createIOSXcodeChildEnvironment(process.env),
      timeoutMs: 5_000,
      maxOutputBytes: 128,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
  });

  test("terminates a subprocess after its hard timeout", async () => {
    const script = join(root, "hang.ts");
    await Bun.write(script, "setInterval(() => {}, 1000);\n");

    const result = await runIOSXcodeCommand([process.execPath, script], {
      cwd: root,
      env: createIOSXcodeChildEnvironment(process.env),
      timeoutMs: 20,
      maxOutputBytes: 128,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("terminates descendants even when the leader exits before forced cleanup", async () => {
    if (process.platform === "win32") return;

    const descendantScript = join(root, "ignore-termination.ts");
    await Bun.write(
      descendantScript,
      'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
    );
    const parentScript = join(root, "spawn-descendant.ts");
    await Bun.write(
      parentScript,
      `const child = Bun.spawn([process.execPath, ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\nconsole.log(child.pid);\nsetInterval(() => {}, 1000);\n`,
    );

    let descendantPid: number | undefined;
    try {
      const result = await runIOSXcodeCommand([process.execPath, parentScript], {
        cwd: root,
        env: createIOSXcodeChildEnvironment(process.env),
        timeoutMs: 200,
        maxOutputBytes: 128,
      });
      descendantPid = Number(result.stdout.trim());

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
    }
  });
});
