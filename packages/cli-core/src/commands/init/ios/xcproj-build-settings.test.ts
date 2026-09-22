import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IOSDiagnostic } from "./types.ts";
import { inspectXCProjTargetBuildConfigurations } from "./xcproj-build-settings.ts";
import { xcprojTargets, type XCProjRecord } from "./xcproj.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function inspectFixture(
  projectOverrides: XCProjRecord = {},
  targetOverrides: XCProjRecord = {},
  setup?: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-build-settings-"));
  temporaryDirectories.push(root);
  const projectPath = join(root, "Example.xcodeproj");
  const projectDocumentPath = join(projectPath, "project.xcproj");
  await mkdir(projectPath, { recursive: true });

  const target: XCProjRecord = {
    name: "Example",
    id: "TARGET-ID",
    "product-type": "application",
    "build-settings": {
      PRODUCT_BUNDLE_IDENTIFIER: "$(inherited).Example",
      DEVELOPMENT_TEAM: "ABCDE12345",
      IPHONEOS_DEPLOYMENT_TARGET: "17.0",
      SUPPORTED_PLATFORMS: ["iphoneos", "iphonesimulator"],
    },
    ...targetOverrides,
  };
  const project: XCProjRecord = {
    configurations: ["Debug", "Release"],
    "build-settings": {
      SDKROOT: "iphoneos",
      PRODUCT_BUNDLE_IDENTIFIER: "com.example",
    },
    targets: [target],
    ...projectOverrides,
  };
  const diagnostics: IOSDiagnostic[] = [];
  await setup?.(root);
  const configurations = await inspectXCProjTargetBuildConfigurations({
    root,
    projectPath,
    projectDocumentPath,
    project,
    target: xcprojTargets(project)[0]!,
    diagnostics,
  });
  return { configurations, diagnostics, projectDocumentPath, root };
}

describe("inspectXCProjTargetBuildConfigurations", () => {
  test("evaluates every project configuration and target inherited values", async () => {
    const { configurations, diagnostics } = await inspectFixture();

    expect(configurations.map(({ model }) => model.name)).toEqual(["Debug", "Release"]);
    for (const configuration of configurations) {
      expect(configuration.model.bundleIdentifier).toMatchObject({
        state: "resolved",
        value: "com.example.Example",
      });
      expect(configuration.model.developmentTeam).toMatchObject({
        state: "resolved",
        value: "ABCDE12345",
      });
      expect(configuration.platformEvidenceComplete).toBe(true);
      expect(configuration.supportedPlatforms).toEqual(["ios"]);
    }
    expect(diagnostics).toEqual([]);
  });

  test("applies configuration-conditional target overrides", async () => {
    const { configurations } = await inspectFixture(
      {},
      {
        "build-settings": {
          PRODUCT_BUNDLE_IDENTIFIER: "$(inherited).Example",
          DEVELOPMENT_TEAM: "BASETEAM123",
          "DEVELOPMENT_TEAM[config=Debug]": "DEBUG12345",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
    );

    expect(configurations[0]?.model).toMatchObject({
      name: "Debug",
      developmentTeam: { state: "resolved", value: "DEBUG12345" },
    });
    expect(configurations[1]?.model).toMatchObject({
      name: "Release",
      developmentTeam: { state: "resolved", value: "BASETEAM123" },
    });
  });

  test("preserves SDK-conditional conflicts from the shared evaluator", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {},
      {
        "build-settings": {
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.Example",
          "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]": "com.example.Device",
          "PRODUCT_BUNDLE_IDENTIFIER[sdk=iphonesimulator*]": "com.example.Simulator",
          DEVELOPMENT_TEAM: "ABCDE12345",
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
    );

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "unresolved",
      missingVariables: ["sdk/architecture-conditioned build setting"],
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.conflicting-build-setting",
        evidence: expect.arrayContaining([
          expect.objectContaining({ path: "Example.xcodeproj/project.xcproj" }),
        ]),
      }),
    );
  });

  test("layers path-based project and target xcconfig files", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-xcconfig-"));
    temporaryDirectories.push(root);
    const projectPath = join(root, "Example.xcodeproj");
    const projectDocumentPath = join(projectPath, "project.xcproj");
    await mkdir(join(root, "Config"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await Bun.write(
      join(root, "Config", "Project.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example\nDEVELOPMENT_TEAM = PROJECT1234",
    );
    await Bun.write(
      join(root, "Config", "Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = $(inherited).XCProj\nDEVELOPMENT_TEAM = $(inherited)",
    );
    const rawTarget: XCProjRecord = {
      name: "Example",
      id: "TARGET-ID",
      "product-type": "application",
      "specialized-configurations": [
        {
          name: "Debug",
          file: { anchor: "Config", "relative-path": "Target.xcconfig" },
        },
      ],
      "build-settings": {
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      },
    };
    const project: XCProjRecord = {
      configurations: [
        {
          name: "Debug",
          file: { anchor: "Config", "relative-path": "Project.xcconfig" },
        },
      ],
      files: [
        {
          kind: "group",
          path: "Config",
          children: [{ path: "Project.xcconfig" }, { path: "Target.xcconfig" }],
        },
      ],
      "build-settings": { SDKROOT: "iphoneos" },
      targets: [rawTarget],
    };
    const diagnostics: IOSDiagnostic[] = [];

    const configurations = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath,
      projectDocumentPath,
      project,
      target: xcprojTargets(project)[0]!,
      diagnostics,
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.XCProj",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: "PROJECT1234",
    });
    expect(diagnostics).toEqual([]);
  });

  test("resolves object-form xcconfig anchors through logical groups instead of physical paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-object-xcconfig-"));
    temporaryDirectories.push(root);
    const projectPath = join(root, "Example.xcodeproj");
    const projectDocumentPath = join(projectPath, "project.xcproj");
    await mkdir(join(root, "PhysicalSources"), { recursive: true });
    await mkdir(join(root, "LogicalSources"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await Bun.write(
      join(root, "PhysicalSources", "Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.Correct\nDEVELOPMENT_TEAM = CORRECT123",
    );
    await Bun.write(
      join(root, "LogicalSources", "Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.Wrong\nDEVELOPMENT_TEAM = WRONG12345",
    );
    const rawTarget: XCProjRecord = {
      name: "Example",
      id: "TARGET-ID",
      "product-type": "application",
      "specialized-configurations": [
        {
          name: "Debug",
          file: { anchor: "LogicalSources", "relative-path": "Target.xcconfig" },
        },
      ],
      "build-settings": {
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      },
    };
    const project: XCProjRecord = {
      configurations: ["Debug"],
      files: [
        {
          kind: "group",
          name: "LogicalSources",
          path: "PhysicalSources",
          children: [{ path: "Target.xcconfig" }],
        },
      ],
      "build-settings": { SDKROOT: "iphoneos" },
      targets: [rawTarget],
    };
    const diagnostics: IOSDiagnostic[] = [];

    const configurations = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath,
      projectDocumentPath,
      project,
      target: xcprojTargets(project)[0]!,
      diagnostics,
    });

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Correct",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: "CORRECT123",
    });
    expect(diagnostics).toEqual([]);
  });

  test("resolves an xcconfig below a top-level synchronized folder without an explicit file leaf", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {
        configurations: ["Debug"],
        files: [{ kind: "folder", path: "Config" }],
        "build-settings": { SDKROOT: "iphoneos" },
      },
      {
        "specialized-configurations": [
          {
            name: "Debug",
            file: { anchor: "Config", "relative-path": "Target.xcconfig" },
          },
        ],
        "build-settings": {
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
      async (root) => {
        await mkdir(join(root, "Config"), { recursive: true });
        await Bun.write(
          join(root, "Config", "Target.xcconfig"),
          "PRODUCT_BUNDLE_IDENTIFIER = com.example.Folder\nDEVELOPMENT_TEAM = FOLDER1234",
        );
      },
    );

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Folder",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: "FOLDER1234",
    });
    expect(diagnostics).toEqual([]);
  });

  test("resolves a nested folder anchor through component-safe logical names and physical paths", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {
        configurations: ["Debug"],
        files: [
          {
            kind: "group",
            name: "Build/Settings",
            path: "PhysicalRoot",
            children: [{ kind: "folder", path: "PhysicalConfigs" }],
          },
        ],
        "build-settings": { SDKROOT: "iphoneos" },
      },
      {
        "specialized-configurations": [
          {
            name: "Debug",
            file: {
              anchor: [{ name: "Build/Settings" }, "PhysicalConfigs"],
              "relative-path": "Target.xcconfig",
            },
          },
        ],
        "build-settings": {
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
      async (root) => {
        await mkdir(join(root, "PhysicalRoot", "PhysicalConfigs"), { recursive: true });
        await Bun.write(
          join(root, "PhysicalRoot", "PhysicalConfigs", "Target.xcconfig"),
          "PRODUCT_BUNDLE_IDENTIFIER = com.example.Nested\nDEVELOPMENT_TEAM = NESTED1234",
        );
      },
    );

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.Nested",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: "NESTED1234",
    });
    expect(diagnostics).toEqual([]);
  });

  test("resolves an xcconfig relative to a synchronized folder object ID", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {
        configurations: ["Debug"],
        files: [{ kind: "folder", id: "CONFIG-FOLDER", path: "PhysicalConfig" }],
        "build-settings": { SDKROOT: "iphoneos" },
      },
      {
        "specialized-configurations": [
          {
            name: "Debug",
            file: { anchor: "id:CONFIG-FOLDER", "relative-path": "Target.xcconfig" },
          },
        ],
        "build-settings": {
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
        },
      },
      async (root) => {
        await mkdir(join(root, "PhysicalConfig"), { recursive: true });
        await Bun.write(
          join(root, "PhysicalConfig", "Target.xcconfig"),
          "PRODUCT_BUNDLE_IDENTIFIER = com.example.ByID\nDEVELOPMENT_TEAM = IDANCHOR12",
        );
      },
    );

    expect(configurations[0]?.model.bundleIdentifier).toMatchObject({
      state: "resolved",
      value: "com.example.ByID",
    });
    expect(configurations[0]?.model.developmentTeam).toMatchObject({
      state: "resolved",
      value: "IDANCHOR12",
    });
    expect(diagnostics).toEqual([]);
  });

  test("fails synchronized-folder anchors closed when the name is ambiguous or the ID is missing", async () => {
    for (const { files, anchor } of [
      {
        files: [
          { kind: "folder", path: "One/Config" },
          { kind: "folder", path: "Two/Config" },
        ],
        anchor: "Config",
      },
      {
        files: [{ kind: "folder", id: "KNOWN-FOLDER", path: "Config" }],
        anchor: "id:MISSING-FOLDER",
      },
    ]) {
      const { configurations, diagnostics } = await inspectFixture(
        { files },
        {
          "specialized-configurations": [
            {
              name: "Debug",
              file: { anchor, "relative-path": "Target.xcconfig" },
            },
          ],
        },
      );

      expect(configurations[0]?.model.bundleIdentifier.state).toBe("unresolved");
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: "xcode.dangling-reference", severity: "error" }),
      );
    }
  });

  test("fails object-form xcconfig anchors closed when the logical path is ambiguous", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {
        files: [
          {
            kind: "group",
            name: "LogicalSources",
            path: "ConfigA",
            children: [{ path: "Target.xcconfig" }],
          },
          {
            kind: "group",
            name: "LogicalSources",
            path: "ConfigB",
            children: [{ path: "Target.xcconfig" }],
          },
        ],
      },
      {
        "specialized-configurations": [
          {
            name: "Debug",
            file: { anchor: "LogicalSources", "relative-path": "Target.xcconfig" },
          },
        ],
      },
    );

    expect(configurations[0]?.model.bundleIdentifier.state).toBe("unresolved");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.dangling-reference", severity: "error" }),
    );
  });

  test("fails object-form xcconfig anchors closed when the logical path is missing", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      { files: [{ path: "Config/Other.xcconfig" }] },
      {
        "specialized-configurations": [
          {
            name: "Debug",
            file: { anchor: "Config", "relative-path": "Target.xcconfig" },
          },
        ],
      },
    );

    expect(configurations[0]?.model.bundleIdentifier.state).toBe("unresolved");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.dangling-reference", severity: "error" }),
    );
  });

  test("resolves Xcode 27 string-form xcconfig references through the file graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-string-xcconfig-"));
    temporaryDirectories.push(root);
    const projectPath = join(root, "Example.xcodeproj");
    const projectDocumentPath = join(projectPath, "project.xcproj");
    await mkdir(join(root, "Config"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await Bun.write(
      join(root, "Config", "Project.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example\nDEVELOPMENT_TEAM = PROJECT1234",
    );
    await Bun.write(
      join(root, "Config", "Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = $(inherited).XCProj\nDEVELOPMENT_TEAM = $(inherited)",
    );
    const rawTarget: XCProjRecord = {
      name: "Example",
      id: "TARGET-ID",
      "product-type": "application",
      "specialized-configurations": [
        { name: "Debug", file: "Target.xcconfig" },
        { name: "Release", file: "Target.xcconfig" },
      ],
      "build-settings": {
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      },
    };
    const project: XCProjRecord = {
      configurations: [
        { name: "Debug", file: "Project.xcconfig" },
        { name: "Release", file: "Project.xcconfig" },
      ],
      files: [{ path: "Config/Project.xcconfig" }, { path: "Config/Target.xcconfig" }],
      "build-settings": { SDKROOT: "iphoneos" },
      targets: [rawTarget],
    };
    const diagnostics: IOSDiagnostic[] = [];

    const configurations = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath,
      projectDocumentPath,
      project,
      target: xcprojTargets(project)[0]!,
      diagnostics,
    });

    expect(configurations).toHaveLength(2);
    for (const configuration of configurations) {
      expect(configuration.model.bundleIdentifier).toMatchObject({
        state: "resolved",
        value: "com.example.XCProj",
      });
      expect(configuration.model.developmentTeam).toMatchObject({
        state: "resolved",
        value: "PROJECT1234",
      });
    }
    expect(diagnostics).toEqual([]);
  });

  test("resolves logical group-qualified xcconfig references to their physical paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-xcproj-logical-xcconfig-"));
    temporaryDirectories.push(root);
    const projectPath = join(root, "Example.xcodeproj");
    const projectDocumentPath = join(projectPath, "project.xcproj");
    await mkdir(join(root, "PhysicalConfigs"), { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await Bun.write(
      join(root, "PhysicalConfigs", "Target.xcconfig"),
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.Logical\nDEVELOPMENT_TEAM = LOGICAL123",
    );
    const rawTarget: XCProjRecord = {
      name: "Example",
      id: "TARGET-ID",
      "product-type": "application",
      "specialized-configurations": [
        { name: "Debug", file: "Build Configurations/Target.xcconfig" },
        { name: "Release", file: "Build Configurations/Target.xcconfig" },
      ],
      "build-settings": {
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      },
    };
    const project: XCProjRecord = {
      configurations: ["Debug", "Release"],
      files: [
        {
          kind: "group",
          name: "Build Configurations",
          path: "PhysicalConfigs",
          children: [{ path: "Target.xcconfig" }],
        },
      ],
      "build-settings": { SDKROOT: "iphoneos" },
      targets: [rawTarget],
    };
    const diagnostics: IOSDiagnostic[] = [];

    const configurations = await inspectXCProjTargetBuildConfigurations({
      root,
      projectPath,
      projectDocumentPath,
      project,
      target: xcprojTargets(project)[0]!,
      diagnostics,
    });

    expect(configurations).toHaveLength(2);
    for (const configuration of configurations) {
      expect(configuration.model.bundleIdentifier).toMatchObject({
        state: "resolved",
        value: "com.example.Logical",
      });
      expect(configuration.model.developmentTeam).toMatchObject({
        state: "resolved",
        value: "LOGICAL123",
      });
    }
    expect(diagnostics).toEqual([]);
  });

  test("fails string-form xcconfig resolution closed when a filename is ambiguous", async () => {
    const { configurations, diagnostics } = await inspectFixture(
      {
        files: [{ path: "ConfigA/Target.xcconfig" }, { path: "ConfigB/Target.xcconfig" }],
      },
      {
        "specialized-configurations": [{ name: "Debug", file: "Target.xcconfig" }],
      },
    );

    expect(configurations[0]?.model.bundleIdentifier.state).toBe("unresolved");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "xcode.dangling-reference",
        severity: "error",
      }),
    );
  });
});
