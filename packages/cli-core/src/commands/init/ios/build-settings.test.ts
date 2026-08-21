import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectTargetBuildConfigurations } from "./build-settings.ts";
import type { PbxObject, PbxObjects } from "./pbx.ts";
import type { IOSDiagnostic } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

interface BuildSettingsFixtureOptions {
  xcconfig?: string;
  includedXCConfig?: string;
  projectDirPath?: string;
  targetBuildSettings?: Record<string, string>;
  projectConfigurationIds?: string[];
  targetConfigurationIds?: string[];
}

async function inspectFixture(options: BuildSettingsFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "clerk-build-settings-"));
  temporaryDirectories.push(root);
  const projectPath = join(root, "Example.xcodeproj");
  const groupRootDirectory = resolve(root, options.projectDirPath ?? "");
  await mkdir(projectPath, { recursive: true });

  const objects: PbxObjects = {
    "project-list": {
      isa: "XCConfigurationList",
      buildConfigurations: options.projectConfigurationIds ?? ["project-debug"],
    },
    "project-debug": {
      isa: "XCBuildConfiguration",
      name: "Debug",
      buildSettings: { SDKROOT: "iphoneos" },
    },
    "target-list": {
      isa: "XCConfigurationList",
      buildConfigurations: options.targetConfigurationIds ?? ["target-debug"],
    },
    "target-debug": {
      isa: "XCBuildConfiguration",
      name: "Debug",
      ...(options.xcconfig ? { baseConfigurationReference: "target-xcconfig" } : {}),
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.Example",
        DEVELOPMENT_TEAM: "ABCDE12345",
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        ...options.targetBuildSettings,
      },
    },
    "target-release": {
      isa: "XCBuildConfiguration",
      name: "Release",
      buildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.Example",
        DEVELOPMENT_TEAM: "ABCDE12345",
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      },
    },
    "target-xcconfig": {
      isa: "PBXFileReference",
      path: "Config/Target.xcconfig",
      sourceTree: "<group>",
    },
  };

  if (options.xcconfig) {
    await mkdir(join(groupRootDirectory, "Config"), { recursive: true });
    await Bun.write(join(groupRootDirectory, "Config", "Target.xcconfig"), options.xcconfig);
    if (options.includedXCConfig != null) {
      await Bun.write(
        join(groupRootDirectory, "Config", "Included.xcconfig"),
        options.includedXCConfig,
      );
    }
  }

  const projectObject: PbxObject = {
    isa: "PBXProject",
    projectDirPath: options.projectDirPath ?? "",
    buildConfigurationList: "project-list",
  };
  const targetObject: PbxObject = {
    isa: "PBXNativeTarget",
    name: "Example",
    productName: "Example",
    buildConfigurationList: "target-list",
  };
  const diagnostics: IOSDiagnostic[] = [];
  const configurations = await inspectTargetBuildConfigurations({
    root,
    projectPath,
    groupRootDirectory,
    projectObject,
    targetId: "target",
    targetObject,
    objects,
    parents: new Map(),
    diagnostics,
  });
  return { configurations, diagnostics, root };
}

describe("inspectTargetBuildConfigurations", () => {
  test("merges braced inherited values across project and target settings", async () => {
    const projectObject: PbxObject = {
      isa: "PBXProject",
      buildConfigurationList: "project-list",
    };
    const targetObject: PbxObject = {
      isa: "PBXNativeTarget",
      name: "Example",
      productName: "Example",
      buildConfigurationList: "target-list",
    };
    const objects: PbxObjects = {
      "project-list": {
        isa: "XCConfigurationList",
        buildConfigurations: ["project-debug"],
      },
      "project-debug": {
        isa: "XCBuildConfiguration",
        name: "Debug",
        buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "com.example", SDKROOT: "iphoneos" },
      },
      "target-list": {
        isa: "XCConfigurationList",
        buildConfigurations: ["target-debug"],
      },
      "target-debug": {
        isa: "XCBuildConfiguration",
        name: "Debug",
        buildSettings: {
          PRODUCT_BUNDLE_IDENTIFIER: "${inherited}.MyApp",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
    };

    const configurations = await inspectTargetBuildConfigurations({
      root: "/tmp/Example",
      projectPath: "/tmp/Example/Example.xcodeproj",
      groupRootDirectory: "/tmp/Example",
      projectObject,
      targetId: "target",
      targetObject,
      objects,
      parents: new Map(),
      diagnostics: [],
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.MyApp",
    });
  });

  test("keeps unsupported Xcode build-setting modifiers unresolved", async () => {
    const projectObject: PbxObject = {
      isa: "PBXProject",
      buildConfigurationList: "project-list",
    };
    const targetObject: PbxObject = {
      isa: "PBXNativeTarget",
      name: "Example",
      productName: "Example",
      buildConfigurationList: "target-list",
    };
    const objects: PbxObjects = {
      "project-list": {
        isa: "XCConfigurationList",
        buildConfigurations: ["project-debug"],
      },
      "project-debug": {
        isa: "XCBuildConfiguration",
        name: "Debug",
        buildSettings: { SDKROOT: "iphoneos" },
      },
      "target-list": {
        isa: "XCConfigurationList",
        buildConfigurations: ["target-debug"],
      },
      "target-debug": {
        isa: "XCBuildConfiguration",
        name: "Debug",
        buildSettings: {
          PRODUCT_NAME: "My App",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.$(PRODUCT_NAME:rfc1034identifier)",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
    };
    const diagnostics: IOSDiagnostic[] = [];

    const configurations = await inspectTargetBuildConfigurations({
      root: "/tmp/Example",
      projectPath: "/tmp/Example/Example.xcodeproj",
      groupRootDirectory: "/tmp/Example",
      projectObject,
      targetId: "target",
      targetObject,
      objects,
      parents: new Map(),
      diagnostics,
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "unresolved",
      raw: "com.example.$(PRODUCT_NAME:rfc1034identifier)",
      missingVariables: ["PRODUCT_NAME:rfc1034identifier"],
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "xcode.unresolved-build-setting",
        message: expect.stringContaining("PRODUCT_NAME:rfc1034identifier"),
      }),
    ]);
  });

  test("uses projectDirPath for group refs while keeping SRCROOT and PROJECT_DIR at the project container", async () => {
    const { configurations, root } = await inspectFixture({
      projectDirPath: "Sources",
      xcconfig: [
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.$(PROJECT_NAME)",
        "DEVELOPMENT_TEAM = $(PROJECT_DIR)",
        "CODE_SIGN_ENTITLEMENTS = $(SRCROOT)/Example.entitlements",
      ].join("\n"),
      targetBuildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)",
        DEVELOPMENT_TEAM: "$(inherited)",
        CODE_SIGN_ENTITLEMENTS: "$(inherited)",
      },
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Example",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: root,
    });
    expect(configurations[0]?.model.entitlementsPath).toMatchObject({
      state: "resolved",
      value: join(root, "Example.entitlements"),
    });
  });

  test("surfaces device and simulator conditional build-setting differences", async () => {
    const { configurations, diagnostics } = await inspectFixture({
      targetBuildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.Base",
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]": "com.example.Device",
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphonesimulator*]": "com.example.Simulator",
      },
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "unresolved",
      missingVariables: ["sdk-conditioned build setting"],
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.conflicting-build-setting",
        message: expect.stringContaining(
          "iphoneos=com.example.Device, iphonesimulator=com.example.Simulator",
        ),
      }),
    );
  });

  test("accepts matching device and simulator conditional build settings", async () => {
    const { configurations } = await inspectFixture({
      targetBuildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.Base",
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]": "com.example.Native",
        "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphonesimulator*]": "com.example.Native",
      },
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Native",
    });
  });

  test("preserves the textual order of xcconfig assignments and includes", async () => {
    const includeLast = await inspectFixture({
      xcconfig: [
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Before",
        '#include "Included.xcconfig"',
      ].join("\n"),
      includedXCConfig: "PRODUCT_BUNDLE_IDENTIFIER = com.example.Included\n",
      targetBuildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
    });
    const assignmentLast = await inspectFixture({
      xcconfig: [
        '#include "Included.xcconfig"',
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.After",
      ].join("\n"),
      includedXCConfig: "PRODUCT_BUNDLE_IDENTIFIER = com.example.Included\n",
      targetBuildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
    });

    expect(includeLast.configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Included",
    });
    expect(assignmentLast.configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.After",
    });
  });

  test("taints fallback settings when a required xcconfig include is missing", async () => {
    const { configurations, diagnostics } = await inspectFixture({
      xcconfig: [
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Fallback",
        '#include "Missing.xcconfig"',
      ].join("\n"),
      targetBuildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "unresolved",
      missingVariables: ["required xcconfig include"],
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.unresolved-build-setting",
        message: expect.stringContaining("Required xcconfig include"),
      }),
    );
  });

  test("clears an earlier unknown-include taint only with a later literal assignment", async () => {
    const { configurations } = await inspectFixture({
      xcconfig: [
        '#include "Missing.xcconfig"',
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Resolved",
        "TEAM_VALUE = ABCDE12345",
        "DEVELOPMENT_TEAM = $(TEAM_VALUE)",
      ].join("\n"),
      targetBuildSettings: {
        PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)",
        DEVELOPMENT_TEAM: "$(inherited)",
      },
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Resolved",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "unresolved",
      missingVariables: ["required xcconfig include"],
    });
  });

  test("taints settings for variable include paths but permits a missing literal optional include", async () => {
    const variable = await inspectFixture({
      xcconfig: [
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Fallback",
        '#include? "$(CONFIG_DIR)/Optional.xcconfig"',
      ].join("\n"),
      targetBuildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
    });
    const literalOptional = await inspectFixture({
      xcconfig: [
        '#include? "Missing.xcconfig"',
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Resolved",
      ].join("\n"),
      targetBuildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
    });

    expect(variable.configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "unresolved",
      missingVariables: ["variable xcconfig include path"],
    });
    expect(variable.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.unresolved-build-setting",
        message: expect.stringContaining("path contains build-setting variables"),
      }),
    );
    expect(literalOptional.configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Resolved",
    });
  });

  test("keeps targets with variable-based platform settings as iOS candidates", async () => {
    const { configurations, diagnostics } = await inspectFixture({
      targetBuildSettings: {
        SDKROOT: "$(UNKNOWN_SDK)",
        SUPPORTED_PLATFORMS: "$(UNKNOWN_PLATFORMS)",
        IPHONEOS_DEPLOYMENT_TARGET: "",
      },
    });

    expect(configurations[0]?.isIOS).toBe(true);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "xcode.unresolved-build-setting",
          message: expect.stringContaining("SDKROOT"),
        }),
        expect.objectContaining({
          code: "xcode.unresolved-build-setting",
          message: expect.stringContaining("SUPPORTED_PLATFORMS"),
        }),
      ]),
    );
  });

  test("keeps targets with include-tainted platform settings as iOS candidates", async () => {
    const { configurations } = await inspectFixture({
      xcconfig: [
        '#include "Missing.xcconfig"',
        "SDKROOT = $(UNKNOWN_SDK)",
        "SUPPORTED_PLATFORMS = $(UNKNOWN_PLATFORMS)",
      ].join("\n"),
      targetBuildSettings: {
        SDKROOT: "$(inherited)",
        SUPPORTED_PLATFORMS: "$(inherited)",
        IPHONEOS_DEPLOYMENT_TARGET: "",
      },
    });

    expect(configurations[0]?.isIOS).toBe(true);
  });

  test("still rejects targets with fully resolved non-iOS platform evidence", async () => {
    const { configurations } = await inspectFixture({
      targetBuildSettings: {
        SDKROOT: "watchos",
        SUPPORTED_PLATFORMS: "watchos watchsimulator",
        IPHONEOS_DEPLOYMENT_TARGET: "",
      },
    });

    expect(configurations[0]?.isIOS).toBe(false);
  });

  test("preserves dangling target configurations as blocking placeholders", async () => {
    const { configurations, diagnostics } = await inspectFixture({
      targetConfigurationIds: ["target-debug", "missing-target-release"],
    });

    expect(configurations).toHaveLength(2);
    expect(configurations[1]?.model).toMatchObject({
      name: "Unresolved (missing-target-release)",
      bundleIdentifier: { state: "missing" },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.dangling-reference",
        severity: "error",
        message: expect.stringContaining("missing-target-release"),
      }),
    );
  });

  test("taints target settings when the project configuration list is incomplete", async () => {
    const { configurations, diagnostics } = await inspectFixture({
      projectConfigurationIds: ["project-debug", "missing-project-release"],
      targetConfigurationIds: ["target-debug", "target-release"],
    });

    expect(configurations.map((configuration) => configuration.model.bundleIdentifier)).toEqual([
      expect.objectContaining({
        state: "unresolved",
        missingVariables: ["incomplete project configuration list"],
      }),
      expect.objectContaining({
        state: "unresolved",
        missingVariables: ["incomplete project configuration list"],
      }),
    ]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.dangling-reference",
        message: expect.stringContaining("missing-project-release"),
      }),
    );
  });
});
