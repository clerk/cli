import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planIOSAssociatedDomain,
  prepareIOSAssociatedDomainMutation,
  validatePreparedIOSAssociatedDomain,
} from "./associated-domain.ts";
import {
  applyIOSAppleEntitlement,
  planIOSAppleEntitlement,
  prepareIOSAppleEntitlementMutation,
  validatePreparedIOSAppleEntitlement,
} from "./apple-entitlement.ts";
import { applyIOSFileTransaction } from "./file-transaction.ts";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const APPLE_KEY = "com.apple.developer.applesignin";
const HOST = "apple-native.clerk.example";
const KEY = `pk_test_${Buffer.from(`${HOST}$`).toString("base64")}`;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-apple-entitlement-"));
  temporaryDirectories.push(root);
  return root;
}

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await temporaryRoot();
  await createIOSFixture(root, options);
  return root;
}

function planOptions(root: string) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
  };
}

function appleBlock(value = "Default", newline = "\n"): string {
  return [
    `\t<key>${APPLE_KEY}</key>`,
    "\t<array>",
    `\t\t<string>${value}</string>`,
    "\t</array>",
  ].join(newline);
}

async function replaceEntitlements(root: string, body: string, newline = "\n"): Promise<string> {
  const path = join(root, "MyApp", "MyApp.entitlements");
  const source = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<!-- preserve this comment -->",
    body,
    "</dict>",
    "</plist>",
    "",
  ].join(newline);
  await writeFile(path, source);
  return source;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS Sign in with Apple entitlement setup", () => {
  test("adds exactly Default while preserving comments, CRLF newlines, mode, and idempotence", async () => {
    const root = await fixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const original = await replaceEntitlements(
      root,
      [
        "\t<key>application-identifier</key>",
        "\t<string>LEGACY1234.com.example.MyApp</string>",
      ].join("\r\n"),
      "\r\n",
    );
    await chmod(path, 0o640);

    const plan = await planIOSAppleEntitlement(planOptions(root));
    const prepared = await prepareIOSAppleEntitlementMutation(plan);

    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "modify" }],
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected prepared Apple mutation");
    expect(prepared.mutations[0]?.boundary.rootPath).toBe(root);
    expect(prepared.mutations[0]?.boundary.realParentPath.endsWith("/MyApp")).toBe(true);
    expect(JSON.stringify({ plan, prepared })).not.toContain("candidateBytes");
    expect(JSON.stringify({ plan, prepared })).not.toContain("<plist");

    const result = await applyIOSAppleEntitlement(plan);
    const source = await readFile(path, "utf8");
    expect(result.status).toBe("applied");
    expect(source).toContain(appleBlock("Default", "\r\n"));
    expect(source).toContain("<!-- preserve this comment -->");
    expect(source).toContain("\r\n");
    expect(source.replace(appleBlock("Default", "\r\n"), "")).toContain(original.split("\r\n")[5]!);
    expect((await lstat(path)).mode & 0o7777).toBe(0o640);

    const digest = await treeDigest(root);
    const rerun = await planIOSAppleEntitlement(planOptions(root));
    expect(rerun.status).toBe("satisfied");
    expect((await applyIOSAppleEntitlement(rerun)).status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(digest);
  });

  test("preserves the closing dict indentation without inserting a whitespace-only line", async () => {
    const root = await fixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const source = (
      await replaceEntitlements(root, "\t<key>existing</key>\n\t<string>value</string>")
    ).replace("\n</dict>", "\n  </dict>");
    await writeFile(path, source);

    const plan = await planIOSAppleEntitlement(planOptions(root));
    const result = await applyIOSAppleEntitlement(plan);
    const updated = await readFile(path, "utf8");

    expect(result.status).toBe("applied");
    expect(updated).toContain(`${appleBlock()}\n  </dict>`);
    expect(updated).not.toContain("\n  \n");
  });

  test("treats only the exact one-element Default array as satisfied", async () => {
    const root = await fixture();
    await replaceEntitlements(root, appleBlock());

    const plan = await planIOSAppleEntitlement(planOptions(root));

    expect(plan.status).toBe("satisfied");
    expect(plan.actions).toEqual([]);
    expect((await prepareIOSAppleEntitlementMutation(plan)).status).toBe("satisfied");
  });

  test("blocks conflicting, malformed, duplicated, and encoded Apple entitlement values", async () => {
    const cases = [
      `<key>${APPLE_KEY}</key><array><string>PrimaryApp</string></array>`,
      `<key>${APPLE_KEY}</key><array><string>Default</string><string>PrimaryApp</string></array>`,
      `<key>${APPLE_KEY}</key><string>Default</string>`,
      `<key>${APPLE_KEY}</key><array><string>Default</string></array><key>${APPLE_KEY}</key><array><string>Default</string></array>`,
      `<key>com.apple.developer.apple&#115;ignin</key><array><string>Default</string></array>`,
    ];
    for (const body of cases) {
      const root = await fixture();
      await replaceEntitlements(root, body);
      const before = await treeDigest(root);

      const plan = await planIOSAppleEntitlement(planOptions(root));

      expect(plan.status).toBe("blocked");
      expect(plan.blockers[0]?.code).toMatch(
        /conflicting-apple-entitlement|unsupported-entitlements/,
      );
      expect((await applyIOSAppleEntitlement(plan)).status).toBe("blocked");
      expect(await treeDigest(root)).toEqual(before);
    }
  });

  test("updates every distinct entitlements variant selected by target configurations", async () => {
    const root = await fixture();
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const debugPath = join(root, "MyApp", "MyApp.entitlements");
    const releasePath = join(root, "MyApp", "MyApp-Release.entitlements");
    await writeFile(releasePath, await readFile(debugPath));
    const project = await readFile(projectPath, "utf8");
    const marker = `${IOS_FIXTURE_IDS.targetRelease} = { isa = XCBuildConfiguration;`;
    const start = project.indexOf(marker);
    const end = project.indexOf("\n    ", start + marker.length);
    await writeFile(
      projectPath,
      `${project.slice(0, start)}${project
        .slice(start, end)
        .replace(
          "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements;",
          "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp-Release.entitlements;",
        )}${project.slice(end)}`,
    );

    const plan = await planIOSAppleEntitlement(planOptions(root));
    const result = await applyIOSAppleEntitlement(plan);

    expect(plan.files.map((file) => file.path)).toEqual([
      "MyApp/MyApp-Release.entitlements",
      "MyApp/MyApp.entitlements",
    ]);
    expect(result.status).toBe("applied");
    for (const file of plan.files) {
      expect(await readFile(join(root, file.path), "utf8")).toContain(APPLE_KEY);
    }
  });

  test("inherits exact-target, generated-project, mixed-path, and shared-file safety blockers", async () => {
    const invalid = await fixture();
    expect(
      (await planIOSAppleEntitlement({ ...planOptions(invalid), targetId: "missing" })).blockers[0]
        ?.code,
    ).toBe("invalid-selection");

    const generated = await fixture({ generated: "tuist" });
    expect((await planIOSAppleEntitlement(planOptions(generated))).blockers[0]?.code).toBe(
      "generated-project",
    );

    const mixed = await fixture({ releaseEntitlements: false });
    expect((await planIOSAppleEntitlement(planOptions(mixed))).blockers[0]?.code).toBe(
      "mixed-entitlements",
    );

    const shared = await fixture({ secondTarget: true });
    const projectPath = join(shared, "MyApp.xcodeproj", "project.pbxproj");
    let project = await readFile(projectPath, "utf8");
    for (const id of [IOS_FIXTURE_IDS.secondDebug, IOS_FIXTURE_IDS.secondRelease]) {
      const marker = `${id} = { isa = XCBuildConfiguration; buildSettings = { `;
      project = project.replace(
        marker,
        `${marker}CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements; `,
      );
    }
    await writeFile(projectPath, project);
    expect((await planIOSAppleEntitlement(planOptions(shared))).blockers[0]?.code).toBe(
      "shared-entitlements",
    );

    const outside = await fixture();
    const unsafe = await fixture();
    const unsafePath = join(unsafe, "MyApp", "MyApp.entitlements");
    await rm(unsafePath);
    await symlink(join(outside, "MyApp", "MyApp.entitlements"), unsafePath);
    expect((await planIOSAppleEntitlement(planOptions(unsafe))).blockers[0]?.code).toBe(
      "unsafe-entitlements",
    );
  });

  test("returns stale without touching a post-preview user edit", async () => {
    const root = await fixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const plan = await planIOSAppleEntitlement(planOptions(root));
    await writeFile(path, "newer user bytes\n");

    const result = await applyIOSAppleEntitlement(plan);

    expect(result.status).toBe("stale");
    expect(await readFile(path, "utf8")).toBe("newer user bytes\n");
  });

  test("creates and attaches a missing synchronized-root entitlements file", async () => {
    const root = await fixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const path = join(root, "MyApp", "MyApp.entitlements");

    const plan = await planIOSAppleEntitlement({
      ...planOptions(root),
      allowMissingEntitlementsCreation: true,
    });
    const prepared = await prepareIOSAppleEntitlementMutation(plan);
    const result = await applyIOSAppleEntitlement(plan);

    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "create" }],
      missingEntitlementsSettings: { status: "ready" },
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected prepared Apple create mutation");
    const createMutation = prepared.mutations.find((mutation) => "kind" in mutation);
    expect(createMutation?.boundary.rootPath).toBe(root);
    expect(createMutation?.boundary.realParentPath.endsWith("/MyApp")).toBe(true);
    expect(result.status).toBe("applied");
    expect(await readFile(path, "utf8")).toContain(appleBlock());
    expect((await lstat(path)).mode & 0o7777).toBe(0o644);
    expect((await planIOSAppleEntitlement(planOptions(root))).status).toBe("satisfied");
  });

  test("composes with the Associated Domains create and PBX candidates", async () => {
    const root = await fixture({ includeKey: false });
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    await writeFile(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "${KEY}") }
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
    const associatedPlan = await planIOSAssociatedDomain({
      ...planOptions(root),
      deferToPublishableKey: true,
      allowMissingEntitlementsCreation: true,
    });
    const applePlan = await planIOSAppleEntitlement({
      ...planOptions(root),
      allowMissingEntitlementsCreation: true,
    });
    const associated = await prepareIOSAssociatedDomainMutation(associatedPlan, KEY);
    expect(associated.status).toBe("ready");
    if (associated.status !== "ready") throw new Error("expected Associated Domains candidate");

    const prepared = await prepareIOSAppleEntitlementMutation(applePlan, {
      baseMutations: associated.mutations,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected composed Apple candidate");
    expect(prepared.consumedBaseMutationPaths).toEqual(
      associated.mutations.map((mutation) => mutation.path).sort(),
    );
    const associatedCreate = associated.mutations.find((mutation) => "kind" in mutation);
    const appleCreate = prepared.mutations.find((mutation) => "kind" in mutation);
    expect(appleCreate?.boundary).toEqual(associatedCreate?.boundary);
    expect(JSON.stringify(prepared)).not.toContain("candidateBytes");

    const result = await applyIOSFileTransaction(prepared.mutations, [
      () => validatePreparedIOSAppleEntitlement(prepared),
      () => validatePreparedIOSAssociatedDomain(associated),
    ]);
    const source = await readFile(join(root, "MyApp", "MyApp.entitlements"), "utf8");

    expect(result.status).toBe("applied");
    expect(source).toContain(APPLE_KEY);
    expect(source).toContain(`webcredentials:${HOST}`);
  });

  test("composes with an existing entitlements candidate and rolls the aggregate write back", async () => {
    const root = await fixture();
    const path = join(root, "MyApp", "MyApp.entitlements");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      source.replace("webcredentials:clerk.example.test", "applinks:keep.test"),
    );
    const before = await readFile(path);
    const associatedPlan = await planIOSAssociatedDomain({
      ...planOptions(root),
      deferToPublishableKey: true,
    });
    const associated = await prepareIOSAssociatedDomainMutation(associatedPlan, KEY);
    expect(associated.status).toBe("ready");
    if (associated.status !== "ready") throw new Error("expected Associated Domains candidate");
    const applePlan = await planIOSAppleEntitlement(planOptions(root));
    const prepared = await prepareIOSAppleEntitlementMutation(applePlan, {
      baseMutations: associated.mutations,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected composed Apple candidate");

    const result = await applyIOSFileTransaction(prepared.mutations, [() => false]);

    expect(result.status).toBe("rolled-back");
    expect(await readFile(path)).toEqual(before);
  });
});
