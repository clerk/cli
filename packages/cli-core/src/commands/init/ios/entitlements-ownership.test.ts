import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIOSFixture,
  convertIOSFixtureToSynchronizedMissingEntitlements,
  IOS_FIXTURE_IDS as ids,
} from "./test-helpers.ts";
import type { PbxObjects } from "./pbx.ts";
import { applyIOSAssociatedDomain, planIOSAssociatedDomain } from "./associated-domain.ts";
import { planIOSAppleEntitlement } from "./apple-entitlement.ts";
import { planMacOSNetworkCapability } from "./macos-network.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(missing: boolean, evidence: string, platform: "ios" | "macos" = "ios") {
  const root = await mkdtemp(join(tmpdir(), "clerk-entitlement-ownership-"));
  roots.push(root);
  await createIOSFixture(root, { secondTarget: true, platform });
  if (missing) await convertIOSFixtureToSynchronizedMissingEntitlements(root);
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parse(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  for (const id of [ids.secondDebug, ids.secondRelease]) {
    const settings = objects[id]!.buildSettings as Record<string, unknown>;
    settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator xros xrsimulator";
    if (evidence === "inline")
      settings["CODE_SIGN_ENTITLEMENTS[sdk=xros*]"] = "MyApp/MyApp.entitlements";
    if (evidence === "project") {
      for (const projectId of [ids.projectDebug, ids.projectRelease]) {
        (objects[projectId]!.buildSettings as Record<string, unknown>)[
          "CODE_SIGN_ENTITLEMENTS[sdk=xros*]"
        ] = "MyApp/MyApp.entitlements";
      }
    }
    if (["xcconfig", "missing-include", "unrelated-xcconfig"].includes(evidence)) {
      objects[id]!.baseConfigurationReference = ids.targetXCConfig;
    }
  }
  if (["xcconfig", "missing-include", "unrelated-xcconfig"].includes(evidence)) {
    objects[ids.targetXCConfig] = {
      isa: "PBXFileReference",
      path: "Sibling.xcconfig",
      sourceTree: "<group>",
      lastKnownFileType: "text.xcconfig",
    };
    (objects[ids.mainGroup]!.children as string[]).push(ids.targetXCConfig);
    await writeFile(
      join(root, "Sibling.xcconfig"),
      evidence === "missing-include"
        ? '#include "Missing.xcconfig"\n'
        : evidence === "xcconfig"
          ? "CODE_SIGN_ENTITLEMENTS[sdk=xros*] = MyApp/MyApp.entitlements\n"
          : "SWIFT_VERSION = 6.0\n",
    );
  }
  await writeFile(projectPath, build(project));
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: ids.appTarget,
    platform,
    deferToPublishableKey: true,
    allowMissingEntitlementsCreation: missing,
  };
}

for (const missing of [false, true]) {
  test.each(["none", "unrelated-xcconfig"])(
    `allows ${missing ? "new" : "existing"} entitlements with a sibling having %s entitlement assignments`,
    async (evidence) => {
      const options = await fixture(missing, evidence);
      const plan = await planIOSAssociatedDomain(options);
      expect(plan.status).toBe("ready");
      const key = `pk_test_${Buffer.from("ownership.clerk.example$").toString("base64")}`;
      expect((await applyIOSAssociatedDomain(plan, key)).status).toBe("applied");
      expect((await planIOSAppleEntitlement(options)).status).toBe("ready");
    },
  );
  test.each(["inline", "project", "xcconfig", "missing-include"])(
    `blocks ${missing ? "new" : "existing"} entitlements when sibling ownership is uncertain through %s`,
    async (evidence) => {
      expect((await planIOSAssociatedDomain(await fixture(missing, evidence))).status).toBe(
        "blocked",
      );
    },
  );
}

test("allows macOS networking when a mixed-platform sibling has no entitlement assignments", async () => {
  const options = await fixture(false, "none", "macos");
  const file = join(options.root, "MyApp", "MyApp.entitlements");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "<key>com.apple.security.network.client</key><true/>",
      "",
    ),
  );
  expect((await planMacOSNetworkCapability(options)).status).toBe("ready");
});
