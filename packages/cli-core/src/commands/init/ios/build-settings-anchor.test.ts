import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(change?: (objects: PbxObjects, root: string) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "clerk-xcconfig-anchor-"));
  roots.push(root);
  await createIOSFixture(root);
  await mkdir(join(root, "Config/Nested"), { recursive: true });
  await Bun.write(join(root, "Config/Nested/App.xcconfig"), '#include "../Base.xcconfig"\n');
  await Bun.write(
    join(root, "Config/Base.xcconfig"),
    "PRODUCT_BUNDLE_IDENTIFIER = com.example.Actual\n",
  );
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  objects.anchor = {
    isa: "PBXFileSystemSynchronizedRootGroup",
    path: "Config",
    sourceTree: "<group>",
  };
  (objects[IDS.mainGroup]!.children as string[]).push("anchor");
  for (const id of [IDS.projectDebug, IDS.projectRelease]) {
    (objects[id]!.buildSettings as Record<string, string>).PRODUCT_BUNDLE_IDENTIFIER =
      "com.example.Fallback";
  }
  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    delete (objects[id]!.buildSettings as Record<string, string>).PRODUCT_BUNDLE_IDENTIFIER;
    objects[id]!.baseConfigurationReferenceAnchor = "anchor";
    objects[id]!.baseConfigurationReferenceRelativePath = "Nested/App.xcconfig";
  }
  await change?.(objects, root);
  await Bun.write(path, build(project));
  return inspectIOSProject(root, { target: "MyApp" });
}

test("resolves synchronized-folder xcconfigs and their relative includes instead of an inherited fallback", async () => {
  const result = await fixture();
  expect(result.appTargets[0]?.configurations.map((config) => config.bundleIdentifier)).toEqual([
    expect.objectContaining({ state: "resolved", value: "com.example.Actual" }),
    expect.objectContaining({ state: "resolved", value: "com.example.Actual" }),
  ]);
});

test.each([
  "missing-anchor",
  "missing-path",
  "wrong-group",
  "missing-file",
  "escape",
  "variable",
  "both-references",
  "symlink",
])("does not accept a fallback identity for an unsafe anchored xcconfig: %s", async (kind) => {
  const result = await fixture(async (objects, root) => {
    if (kind === "wrong-group") objects.anchor!.isa = "PBXGroup";
    if (kind === "missing-file") await rm(join(root, "Config/Nested/App.xcconfig"));
    if (kind === "symlink") {
      const outside = await mkdtemp(join(tmpdir(), "clerk-xcconfig-outside-"));
      roots.push(outside);
      await Bun.write(
        join(outside, "App.xcconfig"),
        "PRODUCT_BUNDLE_IDENTIFIER = com.example.Outside\n",
      );
      await rm(join(root, "Config/Nested/App.xcconfig"));
      await symlink(join(outside, "App.xcconfig"), join(root, "Config/Nested/App.xcconfig"));
    }
    for (const id of [IDS.targetDebug, IDS.targetRelease]) {
      const config = objects[id]!;
      if (kind === "missing-anchor") delete config.baseConfigurationReferenceAnchor;
      if (kind === "missing-path") delete config.baseConfigurationReferenceRelativePath;
      if (kind === "escape") config.baseConfigurationReferenceRelativePath = "../App.xcconfig";
      if (kind === "variable")
        config.baseConfigurationReferenceRelativePath = "$(CONFIG_DIR)/App.xcconfig";
      if (kind === "both-references") config.baseConfigurationReference = IDS.appFile;
    }
  });
  for (const config of result.appTargets[0]!.configurations) {
    expect(config.bundleIdentifier.state).toBe("unresolved");
  }
});

test("a literal target override remains authoritative after an unknown base xcconfig", async () => {
  const result = await fixture((objects) => {
    delete objects.anchor;
    for (const id of [IDS.targetDebug, IDS.targetRelease]) {
      (objects[id]!.buildSettings as Record<string, string>).PRODUCT_BUNDLE_IDENTIFIER =
        "com.example.Explicit";
    }
  });
  expect(result.appTargets[0]?.configurations[0]?.bundleIdentifier).toMatchObject({
    state: "resolved",
    value: "com.example.Explicit",
  });
});
