import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectIOSProject, inspectIOSSourceMembership } from "./inspect.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  synchronized?: boolean;
  filename?: string;
  settings?: Record<string, string | readonly string[] | undefined>;
  releaseSettings?: Record<string, string | undefined>;
  xcconfig?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "clerk-source-filters-"));
  roots.push(root);
  await createIOSFixture(root, { xcconfig: options.xcconfig !== undefined });
  const filename = options.filename ?? "Nested/LegacyApp.swift";
  const source = join(root, "MyApp", filename);
  await mkdir(dirname(source), { recursive: true });
  await Bun.write(
    source,
    'import SwiftUI\n@main struct LegacyApp: App { var body: some Scene { WindowGroup { Text("Legacy") } } }\n',
  );
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  if (options.synchronized) {
    objects.sync = {
      isa: "PBXFileSystemSynchronizedRootGroup",
      path: "MyApp",
      sourceTree: "<group>",
    };
    (objects[IDS.mainGroup]!.children as string[]).push("sync");
    objects[IDS.appTarget]!.fileSystemSynchronizedGroups = ["sync"];
  } else {
    objects.legacy = {
      isa: "PBXFileReference",
      path: filename,
      sourceTree: "<group>",
      lastKnownFileType: "sourcecode.swift",
    };
    (objects[IDS.appGroup]!.children as string[]).push("legacy");
    objects.legacyBuild = { isa: "PBXBuildFile", fileRef: "legacy" };
    (objects[IDS.sourcesPhase]!.files as string[]).push("legacyBuild");
  }
  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    Object.assign(
      objects[id]!.buildSettings as object,
      options.settings,
      id === IDS.targetRelease ? options.releaseSettings : {},
    );
  }
  await Bun.write(path, build(project));
  if (options.xcconfig !== undefined)
    await Bun.write(join(root, "Config/Target.xcconfig"), options.xcconfig);
  return root;
}

test.each([false, true])(
  "excludes nonshipping @main sources (synchronized: %s) while preserving ownership evidence",
  async (synchronized) => {
    const root = await fixture({
      synchronized,
      settings: { EXCLUDED_SOURCE_FILE_NAMES: "LegacyApp.swift" },
    });
    const result = await inspectIOSProject(root, { target: "MyApp" });
    expect(result.appTargets[0]?.swift).toMatchObject({
      evidenceComplete: true,
      entryPoints: [expect.objectContaining({ path: "MyApp/MyAppApp.swift" })],
    });
    // Exclusion does not grant exclusive ownership of a file another target references.
    const memberships = await inspectIOSSourceMembership(root);
    expect(
      memberships[0]?.files.some((file) => file.relativePath.endsWith("LegacyApp.swift")),
    ).toBe(true);
  },
);

test.each([
  { pattern: "Legac?App.swift", filename: "Nested/LegacyApp.swift" },
  { pattern: "Legacy[A-Z]pp.swift", filename: "Nested/LegacyApp.swift" },
  { pattern: "Legacy[!a-z]pp.swift", filename: "Nested/LegacyApp.swift" },
  { pattern: "Nested/*.swift", filename: "Nested/LegacyApp.swift" },
  { pattern: "MyApp/Nested/LegacyApp.swift", filename: "Nested/LegacyApp.swift" },
  { pattern: '"Space Name.swift" "Unused.swift"', filename: "Space Name.swift" },
  { pattern: "Space\\ Name.swift", filename: "Space Name.swift" },
  { pattern: ['"Space Name.swift"', "Unused.swift"], filename: "Space Name.swift" },
])("applies Xcode filename patterns: $pattern", async ({ pattern, filename }) => {
  const root = await fixture({ filename, settings: { EXCLUDED_SOURCE_FILE_NAMES: pattern } });
  const result = await inspectIOSProject(root, { target: "MyApp" });
  expect(result.appTargets[0]?.swift.entryPoints).toHaveLength(1);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(true);
});

test.each([
  { EXCLUDED_SOURCE_FILE_NAMES: "legacyapp.swift" },
  { EXCLUDED_SOURCE_FILE_NAMES: "Wrong/LegacyApp.swift" },
  { EXCLUDED_SOURCE_FILE_NAMES: "ted/LegacyApp.swift" },
  { INCLUDED_SOURCE_FILE_NAMES: "MyAppApp.swift" },
  { EXCLUDED_SOURCE_FILE_NAMES: "Legacy*.swift", INCLUDED_SOURCE_FILE_NAMES: "LegacyApp.swift" },
])(
  "keeps shipping files for nonmatching exclusions or an inclusion override: %j",
  async (settings) => {
    const root = await fixture({ settings });
    const result = await inspectIOSProject(root, { target: "MyApp" });
    expect(result.appTargets[0]?.swift.entryPoints).toHaveLength(2);
    expect(result.appTargets[0]?.swift.evidenceComplete).toBe(true);
  },
);

test("includes override exclusions without forming a whitelist", async () => {
  const root = await fixture({
    settings: {
      EXCLUDED_SOURCE_FILE_NAMES: "*.swift",
      INCLUDED_SOURCE_FILE_NAMES: "MyAppApp.swift",
    },
  });
  const result = await inspectIOSProject(root, { target: "MyApp" });
  expect(result.appTargets[0]?.swift.entryPoints).toEqual([
    expect.objectContaining({ path: "MyApp/MyAppApp.swift" }),
  ]);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(true);
});

test("resolves inherited xcconfig source filters and variables", async () => {
  const root = await fixture({
    settings: { EXCLUDED_SOURCE_FILE_NAMES: "$(inherited) Unused.swift" },
    xcconfig:
      "LEGACY_SOURCE = LegacyApp.swift\nEXCLUDED_SOURCE_FILE_NAMES = $(LEGACY_SOURCE)\nPRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\n",
  });
  const result = await inspectIOSProject(root, { target: "MyApp" });
  expect(result.appTargets[0]?.swift.entryPoints).toHaveLength(1);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(true);
});

test.each([
  { settings: { EXCLUDED_SOURCE_FILE_NAMES: "$(UNKNOWN)" } },
  { settings: { "EXCLUDED_SOURCE_FILE_NAMES[variant=profile]": "LegacyApp.swift" } },
  { settings: { EXCLUDED_SOURCE_FILE_NAMES: "Legacy[[:upper:]]pp.swift" } },
  { settings: { EXCLUDED_SOURCE_FILE_NAMES: '"LegacyApp.swift' } },
  {
    settings: {
      EXCLUDED_SOURCE_FILE_NAMES: "LegacyApp.swift",
      INCLUDED_SOURCE_FILE_NAMES: "$(UNKNOWN)",
    },
  },
  {
    settings: { EXCLUDED_SOURCE_FILE_NAMES: "LegacyApp.swift" },
    releaseSettings: { EXCLUDED_SOURCE_FILE_NAMES: "" },
  },
  { settings: { "EXCLUDED_SOURCE_FILE_NAMES[sdk=iphoneos*]": "LegacyApp.swift" } },
  {
    settings: { EXCLUDED_SOURCE_FILE_NAMES: "Legacy.$(CURRENT_ARCH).swift" },
    filename: "Legacy.arm64.swift",
  },
  { xcconfig: '#include "Missing.xcconfig"\nPRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp\n' },
])(
  "retains possible shipping files but marks uncertain or differing filters incomplete: %j",
  async (options) => {
    const root = await fixture(options);
    const result = await inspectIOSProject(root, { target: "MyApp" });
    expect(result.appTargets[0]?.swift.entryPoints).toHaveLength(2);
    expect(result.appTargets[0]?.swift.evidenceComplete).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "xcode.incomplete-source-membership" }),
    );
  },
);

test("resolves CURRENT_ARCH when every supported architecture excludes the same source", async () => {
  const root = await fixture({
    filename: "Legacy.arm64.swift",
    settings: {
      SUPPORTED_PLATFORMS: "iphoneos",
      EXCLUDED_SOURCE_FILE_NAMES: "Legacy.$(CURRENT_ARCH).swift",
    },
  });
  const result = await inspectIOSProject(root, { target: "MyApp" });
  expect(result.appTargets[0]?.swift.entryPoints).toHaveLength(1);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(true);
});
