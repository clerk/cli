import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS } from "./test-helpers.ts";
import type { PbxObjects } from "./pbx.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const xml = (identifier?: string) =>
  `<?xml version="1.0"?><plist version="1.0"><dict>${identifier === undefined ? "" : `<key>CFBundleIdentifier</key><string>${identifier}</string>`}</dict></plist>`;
async function fixture(
  settings: Record<string, string | undefined>,
  plist?: string,
  xcconfig?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "clerk-bundle-identity-"));
  roots.push(root);
  await createIOSFixture(root, { clerkSDK: false });
  if (plist !== undefined) await Bun.write(join(root, "MyApp", "Info.plist"), plist);
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  if (xcconfig !== undefined) {
    await Bun.write(join(root, "Identity.xcconfig"), xcconfig);
    objects.config = {
      isa: "PBXFileReference",
      path: "Identity.xcconfig",
      sourceTree: "SOURCE_ROOT",
    };
  }
  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    const object = objects[id]!;
    if (xcconfig !== undefined) object.baseConfigurationReference = "config";
    Object.assign(object.buildSettings as Record<string, string>, {
      ...(plist === undefined ? {} : { INFOPLIST_FILE: "MyApp/Info.plist" }),
      ...settings,
    });
  }
  await Bun.write(path, build(project));
  return root;
}
async function identities(root: string) {
  return (await inspectIOSProject(root)).appTargets[0]!.configurations.map(
    (c) => c.bundleIdentifier,
  );
}

test.each([
  { name: "generated identity", settings: {}, expected: "com.example.MyApp" },
  {
    name: "explicit manual identity",
    settings: { GENERATE_INFOPLIST_FILE: "NO" },
    plist: xml("com.example.actual"),
    expected: "com.example.actual",
  },
  {
    name: "generated identity overrides the explicit plist",
    settings: {},
    plist: xml("com.example.actual"),
    expected: "com.example.MyApp",
  },
  {
    name: "generated identity supplies a missing plist key",
    settings: {},
    plist: xml(),
    expected: "com.example.MyApp",
  },
  {
    name: "generated identity overrides INFOPLIST_KEY_CFBundleIdentifier",
    settings: { INFOPLIST_KEY_CFBundleIdentifier: "com.example.other" },
    expected: "com.example.MyApp",
  },
  {
    name: "manual product-variable identity",
    settings: { GENERATE_INFOPLIST_FILE: "NO" },
    plist: xml("$(PRODUCT_BUNDLE_IDENTIFIER)"),
    expected: "com.example.MyApp",
  },
  {
    name: "manual custom-variable identity",
    settings: { GENERATE_INFOPLIST_FILE: "NO", ACTUAL_ID: "com.example.actual" },
    plist: xml("${ACTUAL_ID}"),
    expected: "com.example.actual",
  },
  {
    name: "variable plist path",
    settings: { GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_FILE: "$(SRCROOT)/MyApp/Info.plist" },
    plist: xml("com.example.actual"),
    expected: "com.example.actual",
  },
])("resolves $name", async ({ settings, plist, expected }) => {
  const root = await fixture(settings, plist);
  for (const identity of await identities(root))
    expect(identity).toMatchObject({ state: "resolved", value: expected });
});

test.each([
  {
    name: "missing explicit file",
    settings: { GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_FILE: "Missing.plist" },
  },
  { name: "missing generated and explicit identity", settings: { GENERATE_INFOPLIST_FILE: "NO" } },
  { name: "unresolved file path", settings: { INFOPLIST_FILE: "$(UNKNOWN)/Info.plist" } },
  {
    name: "unresolved manual key",
    settings: { GENERATE_INFOPLIST_FILE: "NO" },
    plist: xml("$(UNKNOWN)"),
  },
  { name: "missing manual key", settings: { GENERATE_INFOPLIST_FILE: "NO" }, plist: xml() },
  {
    name: "invalid key type",
    settings: { GENERATE_INFOPLIST_FILE: "NO" },
    plist: xml("com.example.actual").replace(
      "<string>com.example.actual</string>",
      "<integer>42</integer>",
    ),
  },
  {
    name: "preprocessed plist",
    settings: { GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_PREPROCESS: "YES" },
    plist: xml("com.example.actual"),
  },
  {
    name: "unknown generation mode",
    settings: { GENERATE_INFOPLIST_FILE: "$(UNKNOWN)" },
    plist: xml("com.example.actual"),
  },
  { name: "unsupported generation mode", settings: { GENERATE_INFOPLIST_FILE: "maybe" } },
  { name: "malformed plist", settings: { GENERATE_INFOPLIST_FILE: "NO" }, plist: "not a plist" },
])("keeps $name unproven", async ({ settings, plist }) => {
  const root = await fixture(settings, plist);
  for (const identity of await identities(root)) expect(identity.state).toBe("unresolved");
});

test("preserves literal plist values when expansion is disabled", async () => {
  const root = await fixture(
    { GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_EXPAND_BUILD_SETTINGS: "NO" },
    xml("$(PRODUCT_BUNDLE_IDENTIFIER)"),
  );
  for (const identity of await identities(root))
    expect(identity).toMatchObject({ state: "resolved", value: "$(PRODUCT_BUNDLE_IDENTIFIER)" });
});

test("does not follow an external Info.plist symlink", async () => {
  const root = await fixture({ GENERATE_INFOPLIST_FILE: "NO", INFOPLIST_FILE: "MyApp/Info.plist" });
  const external = await mkdtemp(join(tmpdir(), "clerk-external-plist-"));
  roots.push(external);
  await Bun.write(join(external, "Info.plist"), xml("com.example.external"));
  await symlink(join(external, "Info.plist"), join(root, "MyApp/Info.plist"));
  for (const identity of await identities(root)) expect(identity.state).toBe("unresolved");
});

test.each(["inline", "xcconfig"])(
  "compares %s CPU-specific identities with packaging",
  async (source) => {
    const root = await fixture(
      source === "inline"
        ? {
            "PRODUCT_BUNDLE_IDENTIFIER[arch=*]": "com.example.broad",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=arm64]": "com.example.narrow",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=x86_64]": "com.example.narrow",
          }
        : { PRODUCT_BUNDLE_IDENTIFIER: "$(inherited)" },
      undefined,
      source === "xcconfig"
        ? [
            "PRODUCT_BUNDLE_IDENTIFIER[arch=*] = com.example.broad",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=arm64] = com.example.narrow",
            "PRODUCT_BUNDLE_IDENTIFIER[arch=x86_64] = com.example.narrow",
          ].join("\n")
        : undefined,
    );
    for (const identity of await identities(root))
      expect(identity).toMatchObject({
        state: "unresolved",
        raw: expect.stringContaining("packaging=com.example.broad"),
      });
  },
);

test("accepts matching compiler and packaging identities", async () => {
  const root = await fixture({
    PRODUCT_BUNDLE_IDENTIFIER: "com.example.actual",
    "PRODUCT_BUNDLE_IDENTIFIER[arch=arm64]": "com.example.actual",
    "PRODUCT_BUNDLE_IDENTIFIER[arch=x86_64]": "com.example.actual",
  });
  for (const identity of await identities(root))
    expect(identity).toMatchObject({ state: "resolved", value: "com.example.actual" });
});

test.each(["INHERITED", "Inherited"])(
  "expands user-defined %s case-sensitively in xcconfig, nested settings, and plist",
  async (variable) => {
    for (const source of ["inline", "xcconfig", "nested", "plist"]) {
      const expression = `$(${variable}).app`;
      const settings: Record<string, string> = { [variable]: "com.example.actual" };
      if (source === "inline") settings.PRODUCT_BUNDLE_IDENTIFIER = expression;
      if (source === "xcconfig") settings.PRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";
      if (source === "nested") {
        settings.NESTED = expression;
        settings.PRODUCT_BUNDLE_IDENTIFIER = "$(NESTED)";
      }
      if (source === "plist") settings.GENERATE_INFOPLIST_FILE = "NO";
      const root = await fixture(
        settings,
        source === "plist" ? xml(expression) : undefined,
        source === "xcconfig" ? `PRODUCT_BUNDLE_IDENTIFIER = ${expression}` : undefined,
      );
      for (const identity of await identities(root))
        expect(identity).toMatchObject({ state: "resolved", value: "com.example.actual.app" });
    }
  },
);

test("keeps an undefined uppercase variable unresolved", async () => {
  const root = await fixture({ PRODUCT_BUNDLE_IDENTIFIER: "$(INHERITED).app" });
  for (const identity of await identities(root))
    expect(identity).toMatchObject({
      state: "unresolved",
      missingVariables: expect.arrayContaining(["INHERITED"]),
    });
});

test("does not use packaging contexts to filter shipping Swift sources", async () => {
  const root = await fixture({
    "EXCLUDED_SOURCE_FILE_NAMES[arch=arm64]": "Legacy.swift",
    "EXCLUDED_SOURCE_FILE_NAMES[arch=x86_64]": "Legacy.swift",
  });
  await mkdir(join(root, "MyApp/build"), { recursive: true });
  await Bun.write(
    join(root, "MyApp/build/Legacy.swift"),
    'import SwiftUI\n@main struct Legacy: App { var body: some Scene { WindowGroup { Text("Legacy") } } }',
  );
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  objects.sync = {
    isa: "PBXFileSystemSynchronizedRootGroup",
    path: "MyApp",
    sourceTree: "<group>",
  };
  (objects[IDS.mainGroup]!.children as string[]).push("sync");
  objects[IDS.appTarget]!.fileSystemSynchronizedGroups = ["sync"];
  await Bun.write(path, build(project));
  const swift = (await inspectIOSProject(root)).appTargets[0]!.swift;
  expect(swift.evidenceComplete).toBe(true);
  expect(swift.entryPoints).toHaveLength(1);
});
