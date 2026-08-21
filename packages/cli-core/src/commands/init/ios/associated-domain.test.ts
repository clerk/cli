import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parsePbxProject } from "@bacons/xcode/json";
import {
  applyIOSAssociatedDomain,
  planIOSAssociatedDomain,
  prepareIOSAssociatedDomainMutation,
} from "./associated-domain.ts";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";
import type { PbxObjects } from "./pbx.ts";

const temporaryDirectories: string[] = [];
const HOST = "direct.clerk.example";
const KEY = `pk_test_${Buffer.from(`${HOST}$`).toString("base64")}`;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-associated-domain-"));
  temporaryDirectories.push(root);
  return root;
}

function directSource(key = KEY): string {
  return `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${key}")
  }

  var body: some Scene { WindowGroup { Text("Hello") } }
}
`;
}

async function directFixture(
  options: Parameters<typeof createIOSFixture>[1] = {},
): Promise<string> {
  const root = await temporaryRoot();
  await createIOSFixture(root, { ...options, includeKey: false });
  await Bun.write(join(root, "MyApp", "MyAppApp.swift"), directSource());
  return root;
}

function planOptions(root: string, deferToPublishableKey = false) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
    deferToPublishableKey,
  };
}

async function removeAssociatedDomains(root: string, newline = "\n"): Promise<void> {
  const path = join(root, "MyApp", "MyApp.entitlements");
  const source = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<!-- preserve this comment -->",
    "\t<key>application-identifier</key>",
    "\t<string>LEGACY1234.com.example.MyApp</string>",
    "\t<key>com.apple.developer.team-identifier</key>",
    "\t<string>ABCDE12345</string>",
    "</dict>",
    "</plist>",
    "",
  ].join(newline);
  await writeFile(path, source);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS Associated Domains setup", () => {
  test("creates and attaches an iOS-only entitlements file for a synchronized multiplatform target", async () => {
    const root = await directFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const path = join(root, "MyApp", "MyApp.entitlements");

    const plan = await planIOSAssociatedDomain({
      ...planOptions(root),
      allowMissingEntitlementsCreation: true,
    });
    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "create" }],
      missingEntitlementsSettings: {
        status: "ready",
        buildSettingPath: "MyApp/MyApp.entitlements",
      },
    });
    expect(JSON.stringify(plan)).not.toContain(KEY);

    const result = await applyIOSAssociatedDomain(plan);
    expect(result.status).toBe("applied");
    const entitlements = await readFile(path, "utf8");
    expect(entitlements).toContain(`<string>webcredentials:${HOST}</string>`);
    expect(entitlements).not.toContain("application-identifier");
    expect((await lstat(path)).mode & 0o7777).toBe(0o644);

    const archive = parsePbxProject(
      await readFile(join(root, "MyApp.xcodeproj", "project.pbxproj"), "utf8"),
    ) as unknown as { objects: PbxObjects };
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      const settings = archive.objects[id]!.buildSettings as Record<string, unknown>;
      expect(settings.CODE_SIGN_ENTITLEMENTS).toBeUndefined();
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBe("MyApp/MyApp.entitlements");
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"]).toBe(
        "MyApp/MyApp.entitlements",
      );
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBe("MyApp/MyApp.mac.entitlements");
    }

    const digest = await treeDigest(root);
    const rerun = await planIOSAssociatedDomain(planOptions(root));
    expect(rerun.status).toBe("satisfied");
    expect((await applyIOSAssociatedDomain(rerun)).status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(digest);
  });

  test("plans and applies the exact domain to an existing XML entitlements file", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    await removeAssociatedDomains(root, "\r\n");
    await chmod(path, 0o640);

    const plan = await planIOSAssociatedDomain(planOptions(root));

    expect(plan).toMatchObject({
      status: "ready",
      expectedDomain: `webcredentials:${HOST}`,
      requiresPublishableKey: false,
      files: [{ path: "MyApp/MyApp.entitlements" }],
    });
    const result = await applyIOSAssociatedDomain(plan);
    const source = await readFile(path, "utf8");
    expect(result.status).toBe("applied");
    expect(source).toContain(`\t\t<string>webcredentials:${HOST}</string>`);
    expect(source).toContain("<!-- preserve this comment -->");
    expect(source).toContain("\r\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o640);
    expect(JSON.stringify({ plan, result })).not.toContain(KEY);

    const digest = await treeDigest(root);
    const secondPlan = await planIOSAssociatedDomain(planOptions(root));
    expect(secondPlan.status).toBe("satisfied");
    expect((await applyIOSAssociatedDomain(secondPlan)).status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(digest);
  });

  test("adds a bare entry while preserving Apple's developer-mode entry", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace("webcredentials:clerk.example.test", `webcredentials:${HOST}?mode=developer`),
    );

    const plan = await planIOSAssociatedDomain(planOptions(root));
    const result = await applyIOSAssociatedDomain(plan);
    const updated = await readFile(path, "utf8");

    expect(plan.status).toBe("ready");
    expect(result.status).toBe("applied");
    expect(updated).toContain(`webcredentials:${HOST}?mode=developer`);
    expect(updated).toContain(`webcredentials:${HOST}`);
  });

  test("preserves a multiline nonempty array's closing line and indentation", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const compact =
      "<key>com.apple.developer.associated-domains</key><array><string>webcredentials:clerk.example.test</string></array>";
    const existingBlock = [
      "\t<key>com.apple.developer.associated-domains</key>",
      "\t<array>",
      "\t\t<string>webcredentials:clerk.example.test</string>",
      "\t</array>",
    ].join("\n");
    const source = (await readFile(path, "utf8")).replace(compact, existingBlock);
    await writeFile(path, source);

    const plan = await planIOSAssociatedDomain(planOptions(root));
    const result = await applyIOSAssociatedDomain(plan);
    const expectedBlock = existingBlock.replace(
      "\t</array>",
      `\t\t<string>webcredentials:${HOST}</string>\n\t</array>`,
    );

    expect(plan.status).toBe("ready");
    expect(result.status).toBe("applied");
    expect(await readFile(path, "utf8")).toBe(source.replace(existingBlock, expectedBlock));
  });

  test("patches every distinct existing entitlements file", async () => {
    const root = await directFixture();
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await removeAssociatedDomains(root);
    await writeFile(
      join(root, "MyApp", "MyApp-Release.entitlements"),
      (await readFile(join(root, "MyApp", "MyApp.entitlements"), "utf8")).replace(
        "preserve this comment",
        "release comment",
      ),
    );
    const project = await readFile(projectPath, "utf8");
    const releaseMarker = `${IOS_FIXTURE_IDS.targetRelease} = { isa = XCBuildConfiguration;`;
    const releaseStart = project.indexOf(releaseMarker);
    expect(releaseStart).toBeGreaterThan(-1);
    const nextObject = project.indexOf("\n    ", releaseStart + releaseMarker.length);
    const releaseObject = project.slice(releaseStart, nextObject);
    await writeFile(
      projectPath,
      `${project.slice(0, releaseStart)}${releaseObject.replace(
        "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements;",
        "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp-Release.entitlements;",
      )}${project.slice(nextObject)}`,
    );

    const plan = await planIOSAssociatedDomain(planOptions(root));
    const result = await applyIOSAssociatedDomain(plan);

    expect(plan.files.map((file) => file.path)).toEqual([
      "MyApp/MyApp-Release.entitlements",
      "MyApp/MyApp.entitlements",
    ]);
    expect(result.status).toBe("applied");
    for (const file of plan.files) {
      expect(await readFile(join(root, file.path), "utf8")).toContain(`webcredentials:${HOST}`);
    }
  });

  test("blocks distinct selected-target paths that hardlink the same entitlements file", async () => {
    const root = await directFixture();
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const debugEntitlements = join(root, "MyApp", "MyApp.entitlements");
    const releaseEntitlements = join(root, "MyApp", "MyApp-Release.entitlements");
    await removeAssociatedDomains(root);
    await link(debugEntitlements, releaseEntitlements);
    const project = await readFile(projectPath, "utf8");
    const releaseMarker = `${IOS_FIXTURE_IDS.targetRelease} = { isa = XCBuildConfiguration;`;
    const releaseStart = project.indexOf(releaseMarker);
    expect(releaseStart).toBeGreaterThan(-1);
    const nextObject = project.indexOf("\n    ", releaseStart + releaseMarker.length);
    const releaseObject = project.slice(releaseStart, nextObject);
    await writeFile(
      projectPath,
      `${project.slice(0, releaseStart)}${releaseObject.replace(
        "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements;",
        "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp-Release.entitlements;",
      )}${project.slice(nextObject)}`,
    );

    const before = await treeDigest(root);
    const plan = await planIOSAssociatedDomain(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "shared-entitlements" }));
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks an entitlements file referenced by a target in another Xcode project", async () => {
    const root = await directFixture();
    const secondaryRoot = join(root, "Secondary");
    const secondaryProjectPath = join(secondaryRoot, "MyApp.xcodeproj", "project.pbxproj");
    const secondaryTargetId = "919191919191919191919191";
    await createIOSFixture(secondaryRoot, { includeKey: false });
    const secondaryProject = (await readFile(secondaryProjectPath, "utf8"))
      .replaceAll(IOS_FIXTURE_IDS.appTarget, secondaryTargetId)
      .replaceAll(
        "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements;",
        "CODE_SIGN_ENTITLEMENTS = ../MyApp/MyApp.entitlements;",
      );
    await writeFile(secondaryProjectPath, secondaryProject);

    const before = await treeDigest(root);
    const plan = await planIOSAssociatedDomain(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "shared-entitlements" }));
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks nested selected projects owned by XcodeGen or Tuist", async () => {
    for (const [marker, contents] of [
      ["project.yml", "name: MyApp\n"],
      ["Project.swift", "import ProjectDescription\n"],
    ] as const) {
      const root = await temporaryRoot();
      const nestedRoot = join(root, "ios");
      await createIOSFixture(nestedRoot, { includeKey: false });
      await writeFile(join(nestedRoot, "MyApp", "MyAppApp.swift"), directSource());
      await writeFile(join(nestedRoot, marker), contents);
      const before = await treeDigest(root);

      const plan = await planIOSAssociatedDomain({
        root,
        projectPath: "ios/MyApp.xcodeproj",
        targetId: IOS_FIXTURE_IDS.appTarget,
      });

      expect(plan.status).toBe("blocked");
      expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "generated-project" }));
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("preauthorizes a redacted deferred host for the aggregate direct-config transaction", async () => {
    const root = await temporaryRoot();
    await createIOSFixture(root, { includeKey: false });
    await removeAssociatedDomains(root);

    const plan = await planIOSAssociatedDomain(planOptions(root, true));
    const prepared = await prepareIOSAssociatedDomainMutation(plan, KEY);

    expect(plan).toMatchObject({
      status: "ready",
      requiresPublishableKey: true,
    });
    expect(plan.expectedDomain).toBeUndefined();
    expect(prepared.status).toBe("ready");
    expect(JSON.stringify({ plan, prepared })).not.toContain(KEY);
    expect(JSON.stringify(prepared)).not.toContain("candidateBytes");
  });

  test("returns stale when the selected target's inline key host changes after planning", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    await removeAssociatedDomains(root);
    const originalEntitlements = await readFile(path, "utf8");
    const plan = await planIOSAssociatedDomain(planOptions(root));
    const newerKey = `pk_test_${Buffer.from("newer.clerk.example$").toString("base64")}`;
    await writeFile(join(root, "MyApp", "MyAppApp.swift"), directSource(newerKey));

    const prepared = await prepareIOSAssociatedDomainMutation(plan);

    expect(prepared.status).toBe("stale");
    expect(await readFile(path, "utf8")).toBe(originalEntitlements);
  });

  test("blocks mixed, malformed, binary, and symlinked entitlements without writing", async () => {
    const mixed = await directFixture({ releaseEntitlements: false });
    expect((await planIOSAssociatedDomain(planOptions(mixed))).blockers[0]?.code).toBe(
      "mixed-entitlements",
    );

    const malformed = await directFixture();
    await writeFile(join(malformed, "MyApp", "MyApp.entitlements"), "<plist><dict>");
    expect((await planIOSAssociatedDomain(planOptions(malformed))).blockers[0]?.code).toBe(
      "unreadable-entitlements",
    );

    const binary = await directFixture();
    await writeFile(join(binary, "MyApp", "MyApp.entitlements"), "bplist00not-real");
    expect((await planIOSAssociatedDomain(planOptions(binary))).blockers[0]?.code).toBe(
      "unsupported-entitlements",
    );

    const linked = await directFixture();
    const target = join(linked, "MyApp", "MyApp.entitlements");
    const real = join(linked, "MyApp", "Real.entitlements");
    await writeFile(real, await readFile(target));
    await rm(target);
    await symlink(real, target);
    const before = await treeDigest(linked);
    expect((await planIOSAssociatedDomain(planOptions(linked))).blockers[0]?.code).toBe(
      "unsupported-entitlements",
    );
    expect(await treeDigest(linked)).toEqual(before);
  });

  test("blocks an entity-encoded Associated Domains key without rewriting it", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const encoded = (await readFile(path, "utf8")).replace(
      "com.apple.developer.associated-domains",
      "com.apple.developer.associated&#45;domains",
    );
    await writeFile(path, encoded);
    const before = await treeDigest(root);

    const plan = await planIOSAssociatedDomain(planOptions(root));
    const result = await applyIOSAssociatedDomain(plan);

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "unsupported-entitlements" }),
    );
    expect(result.status).toBe("blocked");
    expect(await readFile(path, "utf8")).toBe(encoded);
    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks literal and entity-encoded duplicate Associated Domains keys", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const literal =
      "<key>com.apple.developer.associated-domains</key><array><string>webcredentials:clerk.example.test</string></array>";
    const encoded =
      "<key>com.apple.developer.associated&#45;domains</key><array><string>applinks:preserve.example</string></array>";
    const source = (await readFile(path, "utf8")).replace(literal, `${encoded}${literal}`);
    await writeFile(path, source);

    const plan = await planIOSAssociatedDomain(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "unsupported-entitlements" }),
    );
    expect(await readFile(path, "utf8")).toBe(source);
  });

  test("blocks an entitlements file shared by another native target", async () => {
    const root = await directFixture({ secondTarget: true });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await removeAssociatedDomains(root);
    let project = await readFile(projectPath, "utf8");
    for (const id of [IOS_FIXTURE_IDS.secondDebug, IOS_FIXTURE_IDS.secondRelease]) {
      const marker = `${id} = { isa = XCBuildConfiguration; buildSettings = { `;
      project = project.replace(
        marker,
        `${marker}CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements; `,
      );
    }
    await writeFile(projectPath, project);

    const before = await treeDigest(root);
    const plan = await planIOSAssociatedDomain(planOptions(root));

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "shared-entitlements" }));
    expect(await treeDigest(root)).toEqual(before);
  });

  test("returns stale and preserves newer bytes", async () => {
    const root = await directFixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    await removeAssociatedDomains(root);
    const plan = await planIOSAssociatedDomain(planOptions(root));
    await writeFile(path, "newer user bytes\n");

    const result = await applyIOSAssociatedDomain(plan);

    expect(result.status).toBe("stale");
    expect(await readFile(path, "utf8")).toBe("newer user bytes\n");
  });
});
