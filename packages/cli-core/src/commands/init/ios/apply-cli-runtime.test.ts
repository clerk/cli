import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import { inspectIOSProject } from "./inspect.ts";
import { applyIOSLocalSetup, applyIOSPlannedLocalSetup, applyIOSRuntimeKeySetup } from "./apply.ts";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";
import * as prompts from "../../../lib/prompts.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import type { PbxObjects } from "./pbx.ts";
import {
  authFixtureKey,
  canonicalSwiftUIFixture,
  createIsolatedCLIState,
  createUnconfiguredFixture,
  developmentPublishableKey,
  runCLI,
  runCommand,
  temporaryDirectories,
} from "./apply-cli.test-helpers.ts";

setDefaultTimeout(15_000);

describe("clerk init iOS SDK runtime apply", () => {
  const captured = useCaptureLog();
  test("does not combine LocalSecrets mutation with new entitlements creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-missing-entitlements-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>replace-me</string></dict></plist>',
    );
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    expect(setup.runtimeKeyPlan).toMatchObject({ status: "ready" });
    expect(setup.associatedDomainPlan).toBeUndefined();
    expect(await treeDigest(root)).toEqual(before);
  });

  test("hands off a runtime key without rewriting a fully linked unattributed package graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-unattributed-handoff-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const unattributedProject = (await Bun.file(projectFile).text())
      .replace(
        `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKit;`,
        "productName = ClerkKit;",
      )
      .replace(
        `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKitUI;`,
        "productName = ClerkKitUI;",
      );
    await Bun.write(projectFile, unattributedProject);
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>replace-me</string></dict></plist>',
    );
    const beforeProjectBytes = await Bun.file(projectFile).bytes();

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    expect(setup.runtimeKeyPlan).toMatchObject({ status: "ready" });
    expect(await Bun.file(projectFile).bytes()).toEqual(beforeProjectBytes);

    const key = developmentPublishableKey("unattributed.clerk.example");
    await applyIOSRuntimeKeySetup(setup.runtimeKeyPlan!, key);

    expect(await Bun.file(projectFile).bytes()).toEqual(beforeProjectBytes);
    expect(await Bun.file(join(root, "MyApp", "LocalSecrets.plist")).text()).toContain(key);
  });

  test("does not bypass AuthView compatibility proof for unattributed Clerk products", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-unattributed-auth-view-"));
    temporaryDirectories.push(root);
    await cp(canonicalSwiftUIFixture, root, { recursive: true });

    const initialSetup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
    });
    await applyIOSPlannedLocalSetup(initialSetup, authFixtureKey);

    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const project = parsePbxProject(await Bun.file(projectFile).text());
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    for (const object of Object.values(objects)) {
      if (object.isa === "XCRemoteSwiftPackageReference") {
        object.requirement = { kind: "exactVersion", version: "1.2.0" };
      }
      if (
        object.isa === "XCSwiftPackageProductDependency" &&
        ["ClerkKit", "ClerkKitUI"].includes(String(object.productName))
      ) {
        delete object.package;
      }
    }
    await Bun.write(projectFile, buildPbxProject(project));

    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: true,
        prebuiltAuthUI: true,
      }),
    ).rejects.toThrow("not attributed to a Swift package reference");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("does not bypass unattributed-product review when a policy-required UI product is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-unattributed-missing-ui-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: "core-only",
    });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const unattributedProject = (await Bun.file(projectFile).text()).replace(
      `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKit;`,
      "productName = ClerkKit;",
    );
    await Bun.write(projectFile, unattributedProject);
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow("Clerk iOS SDK could not be installed automatically");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("does not bypass a non-attribution package blocker when all required products are linked", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-wrong-package-runtime-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const wrongPackageId = "919191919191919191919191";
    const malformed = (await Bun.file(projectFile).text())
      .replace(
        `    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
        `    ${wrongPackageId} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://example.com/not-clerk.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };\n    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
      )
      .replaceAll(`package = ${IOS_FIXTURE_IDS.clerkPackage};`, `package = ${wrongPackageId};`);
    await Bun.write(projectFile, malformed);
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow("verified clerk-ios reference");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("does not let an unattributed product hide another product's wrong package", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-mixed-package-runtime-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const wrongPackageId = "919191919191919191919191";
    const mixed = (await Bun.file(projectFile).text())
      .replace(
        `    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
        `    ${wrongPackageId} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://example.com/not-clerk.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };\n    ${IOS_FIXTURE_IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference;`,
      )
      .replace(
        `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKit;`,
        "productName = ClerkKit;",
      )
      .replace(
        `package = ${IOS_FIXTURE_IDS.clerkPackage}; productName = ClerkKitUI;`,
        `package = ${wrongPackageId}; productName = ClerkKitUI;`,
      );
    await Bun.write(projectFile, mixed);
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow("verified clerk-ios reference");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("blocks all local writes when a structurally eligible runtime sink fails strict preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-blocked-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: false,
    });
    await Bun.write(join(root, "MyApp", "LocalSecrets.plist"), "<plist><dict>");
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow("readable XML property-list dictionary");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("a mismatched expected app key blocks before SDK or key mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-relink-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: false,
    });
    const before = await treeDigest(root);
    const expectedKey = developmentPublishableKey("different.clerk.example");

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    await expect(applyIOSPlannedLocalSetup(setup, expectedKey)).rejects.toThrow(
      "does not match the linked Clerk application's development key",
    );

    expect(await treeDigest(root)).toEqual(before);
    expect(`${captured.out}\n${captured.err}`).not.toContain(expectedKey);
  });

  test("a requested app with a satisfied sink fails closed without its expected key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-missing-expected-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: false,
    });
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    await expect(applyIOSPlannedLocalSetup(setup)).rejects.toThrow(
      "development publishable key was not available",
    );

    expect(await treeDigest(root)).toEqual(before);
  });

  test("a matching expected app key permits SDK installation regardless of local profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-match-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: false,
    });
    const key = developmentPublishableKey("matching.clerk.example");
    const localSecretsPath = join(root, "MyApp", "LocalSecrets.plist");
    await Bun.write(
      localSecretsPath,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>${key}</string></dict></plist>`,
    );

    const result = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });
    await applyIOSPlannedLocalSetup(result, key);

    expect(result).toMatchObject({
      requiresLinkedApp: true,
      verifiesExistingKey: true,
    });
    expect((await inspectIOSProject(root, { target: "MyApp" })).appTargets[0]?.packages).toEqual({
      package: "remote",
      clerkKit: "linked",
      clerkKitUI: "linked",
    });
    expect(await Bun.file(localSecretsPath).text()).toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test("a LocalSecrets change during SDK validation rolls the project edit back", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-verification-race-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      complete: true,
      includeKey: false,
      localSecrets: true,
      clerkSDK: false,
    });
    const expectedKey = developmentPublishableKey("verified.clerk.example");
    const concurrentKey = developmentPublishableKey("concurrent.clerk.example");
    const localSecretsPath = join(root, "MyApp", "LocalSecrets.plist");
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    const plist = (key: string) =>
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>${key}</string></dict></plist>`;
    await Bun.write(localSecretsPath, plist(expectedKey));
    const projectBefore = await Bun.file(projectPath).bytes();
    const entitlementsBefore = await Bun.file(entitlementsPath).bytes();

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });

    await expect(
      applyIOSPlannedLocalSetup(setup, expectedKey, {
        beforePostWriteValidation: async () => {
          await Bun.write(localSecretsPath, plist(concurrentKey));
        },
      }),
    ).rejects.toThrow("SDK change was restored byte-for-byte");

    expect(await Bun.file(projectPath).bytes()).toEqual(projectBefore);
    expect(await Bun.file(entitlementsPath).bytes()).toEqual(entitlementsBefore);
    expect(await Bun.file(localSecretsPath).text()).toBe(plist(concurrentKey));
    expect(`${captured.out}\n${captured.err}`).not.toContain(expectedKey);
    expect(`${captured.out}\n${captured.err}`).not.toContain(concurrentKey);
  });

  test("an inline key for another application blocks the SDK and source transaction", async () => {
    const root = await createUnconfiguredFixture();
    const existingKey = developmentPublishableKey("existing-inline.clerk.example");
    const selectedKey = developmentPublishableKey("selected-inline.clerk.example");
    await Bun.write(
      join(root, "MyApp", "MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() {
    Clerk.configure(publishableKey: "${existingKey}")
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
    const before = await treeDigest(root);

    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });
    await expect(applyIOSPlannedLocalSetup(setup, selectedKey)).rejects.toThrow(
      "belongs to a different Clerk application",
    );

    expect(await treeDigest(root)).toEqual(before);
    expect(`${captured.out}\n${captured.err}`).not.toContain(selectedKey);
  });

  test("a post-preview Swift edit prevents both source and SDK writes", async () => {
    const root = await createUnconfiguredFixture();
    const key = developmentPublishableKey("stale-direct.clerk.example");
    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });
    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}\n// concurrent edit\n`);
    const concurrentTree = await treeDigest(root);

    await expect(applyIOSPlannedLocalSetup(setup, key)).rejects.toThrow(
      "Swift app entry source changed after the preview",
    );

    expect(await treeDigest(root)).toEqual(concurrentTree);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toMatchObject({
      clerkKit: "absent",
      clerkKitUI: "absent",
    });
    expect(`${captured.out}\n${captured.err}`).not.toContain(key);
  });

  test("a post-preview entitlements edit prevents both source and SDK writes", async () => {
    const root = await createUnconfiguredFixture();
    const key = developmentPublishableKey("stale-entitlements.clerk.example");
    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: false,
    });
    const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    const projectBefore = await Bun.file(projectPath).bytes();
    const sourceBefore = await Bun.file(sourcePath).bytes();
    const concurrentEntitlements = (await Bun.file(entitlementsPath).text()).replace(
      "<dict>",
      "<dict>\n<!-- concurrent user edit -->",
    );
    await Bun.write(entitlementsPath, concurrentEntitlements);

    await expect(applyIOSPlannedLocalSetup(setup, key)).rejects.toThrow(
      "entitlements file changed after the preview",
    );

    expect(await Bun.file(projectPath).bytes()).toEqual(projectBefore);
    expect(await Bun.file(sourcePath).bytes()).toEqual(sourceBefore);
    expect(await Bun.file(entitlementsPath).text()).toBe(concurrentEntitlements);
    const inspection = await inspectIOSProject(root, { target: "MyApp" });
    expect(inspection.appTargets[0]?.packages).toMatchObject({
      clerkKit: "absent",
      clerkKitUI: "absent",
    });
    expect(`${captured.out}\n${captured.err}`).not.toContain(key);
  });

  test("a declined human confirmation leaves the project byte-identical", async () => {
    const root = await createUnconfiguredFixture();
    const before = await treeDigest(root);
    const confirmation = spyOn(prompts, "confirm").mockResolvedValue(false);

    try {
      await expect(
        applyIOSLocalSetup({
          root,
          target: "MyApp",
          yes: false,
          agent: false,
          allowDirty: false,
        }),
      ).rejects.toMatchObject({ name: "UserAbortError" });
    } finally {
      confirmation.mockRestore();
    }

    expect(await treeDigest(root)).toEqual(before);
  });

  test("dry-run advertises the action but remains byte-for-byte read-only", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(root, ["init", "--dry-run", "--json"], configDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "install-clerk-sdk",
        status: "required",
        automatable: true,
      }),
    );
    expect(await treeDigest(root)).toEqual(before);
  });

  test("dry-run advertises safe missing-entitlements creation without writing", async () => {
    const root = await createUnconfiguredFixture();
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    const configDir = await createIsolatedCLIState();
    const before = await treeDigest(root);

    const result = await runCLI(root, ["init", "--dry-run", "--json"], configDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.plan.steps).toContainEqual(
      expect.objectContaining({
        id: "add-associated-domain",
        status: "required",
        automatable: true,
      }),
    );
    expect(output.nativeReadiness.associatedDomain).toMatchObject({
      status: "required",
      automatable: true,
      files: ["MyApp/MyApp.entitlements"],
      blockers: [],
    });
    expect(JSON.stringify(output)).not.toContain(authFixtureKey);
    expect(await treeDigest(root)).toEqual(before);
  });

  test("requires --allow-dirty for the planned project file and preserves its changes", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await runCommand(root, ["git", "init"]);
    await runCommand(root, ["git", "add", "."]);
    await runCommand(root, [
      "git",
      "-c",
      "user.name=Clerk CLI Tests",
      "-c",
      "user.email=cli-tests@clerk.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const dirtyProject = (await Bun.file(projectFile).text()).replaceAll(
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;",
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp.local;",
    );
    await Bun.write(projectFile, dirtyProject);

    const blocked = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp", "--app-id-prefix", "LEGACY1234"],
      configDir,
    );
    expect(blocked.exitCode).toBe(1);
    expect(`${blocked.stdout}\n${blocked.stderr}`).toContain("--allow-dirty");
    expect(await Bun.file(projectFile).text()).toBe(dirtyProject);

    const applied = await runCLI(
      root,
      [
        "--mode",
        "agent",
        "init",
        "--yes",
        "--allow-dirty",
        "--target",
        "MyApp",
        "--app-id-prefix",
        "LEGACY1234",
      ],
      configDir,
    );
    expect(applied.exitCode).toBe(0);
    expect(await Bun.file(projectFile).text()).toContain(
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp.local;",
    );
  });

  test("requires --allow-dirty for entitlements and preserves unrelated local content", async () => {
    const root = await createUnconfiguredFixture();
    const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
    await runCommand(root, ["git", "init"]);
    await runCommand(root, ["git", "add", "."]);
    await runCommand(root, [
      "git",
      "-c",
      "user.name=Clerk CLI Tests",
      "-c",
      "user.email=cli-tests@clerk.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const localComment = "<!-- preserve this unrelated local entitlement note -->";
    const dirtyEntitlements = (await Bun.file(entitlementsPath).text()).replace(
      "<dict>",
      `<dict>\n${localComment}`,
    );
    await Bun.write(entitlementsPath, dirtyEntitlements);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow("MyApp/MyApp.entitlements already has local changes");
    expect(await Bun.file(entitlementsPath).text()).toBe(dirtyEntitlements);

    const key = developmentPublishableKey("dirty-entitlements.clerk.example");
    const setup = await applyIOSLocalSetup({
      root,
      target: "MyApp",
      yes: true,
      agent: false,
      allowDirty: true,
    });
    await applyIOSPlannedLocalSetup(setup, key);

    const appliedEntitlements = await Bun.file(entitlementsPath).text();
    expect(appliedEntitlements).toContain(localComment);
    expect(appliedEntitlements).toContain("webcredentials:dirty-entitlements.clerk.example");
  });

  test("dirty-checks .gitignore when crash-safe key staging needs a guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-ios-runtime-dirty-ignore-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { complete: true, includeKey: false, localSecrets: true });
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>replace-me</string></dict></plist>',
    );
    await Bun.write(join(root, ".gitignore"), "/MyApp/LocalSecrets.plist\n");
    await runCommand(root, ["git", "init"]);
    await runCommand(root, ["git", "add", "."]);
    await runCommand(root, [
      "git",
      "-c",
      "user.name=Clerk CLI Tests",
      "-c",
      "user.email=cli-tests@clerk.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await Bun.write(join(root, ".gitignore"), "/MyApp/LocalSecrets.plist\n# local change\n");
    const before = await treeDigest(root);

    await expect(
      applyIOSLocalSetup({
        root,
        target: "MyApp",
        yes: true,
        agent: false,
        allowDirty: false,
      }),
    ).rejects.toThrow(".gitignore already has local changes");

    expect(await treeDigest(root)).toEqual(before);
  });

  test("fails closed when Git cannot determine the selected project file status", async () => {
    const root = await createUnconfiguredFixture();
    const configDir = await createIsolatedCLIState();
    const projectFile = join(root, "MyApp.xcodeproj", "project.pbxproj");
    await runCommand(root, ["git", "init"]);
    await runCommand(root, ["git", "add", "."]);
    await runCommand(root, [
      "git",
      "-c",
      "user.name=Clerk CLI Tests",
      "-c",
      "user.email=cli-tests@clerk.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await Bun.write(join(root, ".git", "index"), "not a valid Git index");
    const before = await Bun.file(projectFile).text();

    const result = await runCLI(
      root,
      ["--mode", "agent", "init", "--yes", "--target", "MyApp"],
      configDir,
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("could not be verified");
    expect(await Bun.file(projectFile).text()).toBe(before);
  });
});
