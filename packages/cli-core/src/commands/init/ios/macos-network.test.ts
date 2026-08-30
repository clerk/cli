import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import {
  planIOSAppleEntitlement,
  prepareIOSAppleEntitlementMutation,
  validatePreparedIOSAppleEntitlement,
} from "./apple-entitlement.ts";
import { applyIOSFileTransaction } from "./file-transaction.ts";
import {
  applyMacOSNetworkCapability,
  planMacOSNetworkCapability,
  prepareMacOSNetworkCapabilityMutation,
  validatePreparedMacOSNetworkCapability,
} from "./macos-network.ts";
import type { PbxObjects } from "./pbx.ts";
import {
  convertIOSFixtureToSynchronizedMissingEntitlements,
  createIOSFixture,
  IOS_FIXTURE_IDS,
  treeDigest,
} from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-macos-network-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, {
    platform: "macos",
    includeKey: false,
    macOSAppleEntitlement: false,
  });
  return root;
}

function pbxprojPath(root: string): string {
  return join(root, "MyApp.xcodeproj", "project.pbxproj");
}

function entitlementsPath(root: string): string {
  return join(root, "MyApp", "MyApp.entitlements");
}

function options(root: string, allowMissingEntitlementsCreation = false) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
    allowMissingEntitlementsCreation,
  };
}

async function updateBuildSettings(
  root: string,
  update: (settings: Record<string, unknown>) => void,
): Promise<void> {
  const path = pbxprojPath(root);
  const project = parsePbxProject(await readFile(path, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
    update(objects[id]!.buildSettings as Record<string, unknown>);
  }
  await writeFile(path, buildPbxProject(project));
}

async function enableSandbox(root: string): Promise<void> {
  await updateBuildSettings(root, (settings) => {
    settings.ENABLE_APP_SANDBOX = "YES";
  });
}

async function makeMultiplatform(root: string): Promise<void> {
  await updateBuildSettings(root, (settings) => {
    settings.SDKROOT = "auto";
    settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
    settings.IPHONEOS_DEPLOYMENT_TARGET = "17.0";
    settings.MACOSX_DEPLOYMENT_TARGET = "14.0";
  });
}

async function useSeparatePlatformEntitlements(root: string): Promise<string> {
  const iosPath = join(root, "MyApp", "MyApp.ios.entitlements");
  await writeFile(
    iosPath,
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
  );
  await updateBuildSettings(root, (settings) => {
    delete settings.CODE_SIGN_ENTITLEMENTS;
    settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"] = "MyApp/MyApp.ios.entitlements";
    settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"] = "MyApp/MyApp.ios.entitlements";
    settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"] = "MyApp/MyApp.entitlements";
  });
  return iosPath;
}

async function removeNetworkEntitlement(root: string): Promise<void> {
  const path = entitlementsPath(root);
  const source = (await readFile(path, "utf8")).replace(
    /\s*<key>com\.apple\.security\.network\.client<\/key>\s*<true\s*\/>/,
    "",
  );
  await writeFile(path, source);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("macOS outgoing network capability", () => {
  test("does nothing for a provably unsandboxed macOS app", async () => {
    const root = await temporaryRoot();
    await updateBuildSettings(root, (settings) => {
      delete settings.ENABLE_APP_SANDBOX;
    });
    await writeFile(
      entitlementsPath(root),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
    );
    const before = await treeDigest(root);

    const plan = await planMacOSNetworkCapability(options(root));

    expect(plan).toMatchObject({ status: "satisfied", files: [], blockers: [] });
    expect((await applyMacOSNetworkCapability(plan)).status).toBe("satisfied");
    expect(await treeDigest(root)).toEqual(before);
  });

  test("ignores unresolved outgoing-network settings for a provably unsandboxed app", async () => {
    const root = await temporaryRoot();
    await updateBuildSettings(root, (settings) => {
      settings.ENABLE_APP_SANDBOX = "NO";
      settings.ENABLE_OUTGOING_NETWORK_CONNECTIONS = "$(UNRESOLVED_NETWORK_SETTING)";
    });
    await writeFile(
      entitlementsPath(root),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
    );

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "satisfied",
      files: [],
      blockers: [],
    });
  });

  test("adds only network.client to an existing sandboxed entitlement plist", async () => {
    const root = await temporaryRoot();
    await enableSandbox(root);
    await removeNetworkEntitlement(root);
    const path = entitlementsPath(root);
    const source = (await readFile(path, "utf8")).replace(
      "<key>com.apple.security.app-sandbox</key>",
      "<!-- keep this comment -->\n<key>com.apple.security.app-sandbox</key>",
    );
    await writeFile(path, source);

    const plan = await planMacOSNetworkCapability(options(root));
    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "modify" }],
      blockers: [],
    });
    expect((await applyMacOSNetworkCapability(plan)).status).toBe("applied");

    const after = await readFile(path, "utf8");
    expect(after).toContain("<!-- keep this comment -->");
    expect(after).toContain("<key>com.apple.security.network.client</key>");
    expect(after).toContain("<true/>");
    expect(after).toContain("<key>com.apple.security.app-sandbox</key>");
    expect((await planMacOSNetworkCapability(options(root))).status).toBe("satisfied");
  });

  test("accepts exact outgoing access supplied by entitlements", async () => {
    const root = await temporaryRoot();
    await writeFile(
      entitlementsPath(root),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
`,
    );

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "satisfied",
      blockers: [],
    });
  });

  test("accepts an already-satisfied shared entitlement on a multiplatform target", async () => {
    const root = await temporaryRoot();
    await makeMultiplatform(root);

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "satisfied",
      blockers: [],
    });
  });

  test("modifies only a separately attached macOS entitlement on a multiplatform target", async () => {
    const root = await temporaryRoot();
    await makeMultiplatform(root);
    await enableSandbox(root);
    const iosPath = await useSeparatePlatformEntitlements(root);
    await removeNetworkEntitlement(root);
    const iosBefore = await readFile(iosPath, "utf8");

    const plan = await planMacOSNetworkCapability(options(root));

    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "modify" }],
      blockers: [],
    });
    expect((await applyMacOSNetworkCapability(plan)).status).toBe("applied");
    expect(await readFile(iosPath, "utf8")).toBe(iosBefore);
    expect(await readFile(entitlementsPath(root), "utf8")).toContain(
      "com.apple.security.network.client",
    );
  });

  test("blocks mutating an entitlement shared by iOS and macOS builds", async () => {
    const root = await temporaryRoot();
    await makeMultiplatform(root);
    await enableSandbox(root);
    await removeNetworkEntitlement(root);

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unsafe-entitlements" }],
    });
  });

  test("blocks a macOS entitlement aliased by a sibling multiplatform target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-macos-network-sibling-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, {
      platform: "macos",
      includeKey: false,
      macOSAppleEntitlement: false,
      secondTarget: true,
    });
    await makeMultiplatform(root);
    await enableSandbox(root);
    await useSeparatePlatformEntitlements(root);
    await removeNetworkEntitlement(root);
    const path = pbxprojPath(root);
    const project = parsePbxProject(await readFile(path, "utf8"));
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    for (const id of [IOS_FIXTURE_IDS.secondDebug, IOS_FIXTURE_IDS.secondRelease]) {
      const settings = objects[id]!.buildSettings as Record<string, unknown>;
      settings.SDKROOT = "auto";
      settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
      settings.IPHONEOS_DEPLOYMENT_TARGET = "17.0";
      settings.MACOSX_DEPLOYMENT_TARGET = "14.0";
      settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"] = "MyApp/MyApp.entitlements";
    }
    await writeFile(path, buildPbxProject(project));

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unsafe-entitlements" }],
    });
  });

  test("requires every configuration to prove macOS support", async () => {
    const root = await temporaryRoot();
    await makeMultiplatform(root);
    const path = pbxprojPath(root);
    const project = parsePbxProject(await readFile(path, "utf8"));
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    const release = objects[IOS_FIXTURE_IDS.targetRelease]!.buildSettings as Record<
      string,
      unknown
    >;
    release.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
    await writeFile(path, buildPbxProject(project));

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unresolved-platform" }],
    });
  });

  test("reports a pure iOS target as unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "clerk-macos-network-ios-"));
    temporaryDirectories.push(root);
    await createIOSFixture(root, { includeKey: false });

    await expect(planMacOSNetworkCapability(options(root))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unsupported-platform" }],
    });
  });

  test("blocks explicit false, malformed, and architecture-conflicting values", async () => {
    const explicitFalse = await temporaryRoot();
    await enableSandbox(explicitFalse);
    await updateBuildSettings(explicitFalse, (settings) => {
      settings.ENABLE_OUTGOING_NETWORK_CONNECTIONS = "NO";
    });
    await expect(planMacOSNetworkCapability(options(explicitFalse))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "conflicting-network-setting" }],
    });

    const malformed = await temporaryRoot();
    await enableSandbox(malformed);
    await writeFile(
      entitlementsPath(malformed),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.network.client</key><string>YES</string></dict></plist>`,
    );
    await expect(planMacOSNetworkCapability(options(malformed))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unsupported-entitlements" }],
    });

    const conflicting = await temporaryRoot();
    await updateBuildSettings(conflicting, (settings) => {
      settings["ENABLE_APP_SANDBOX[sdk=macosx*][arch=arm64]"] = "YES";
      settings["ENABLE_APP_SANDBOX[sdk=macosx*][arch=x86_64]"] = "NO";
    });
    await expect(planMacOSNetworkCapability(options(conflicting))).resolves.toMatchObject({
      status: "blocked",
      blockers: [{ code: "unresolved-sandbox-setting" }],
    });
  });

  test("creates a macOS-only entitlement setting and both required capabilities", async () => {
    const root = await temporaryRoot();
    await enableSandbox(root);
    const projectPath = pbxprojPath(root);
    const project = parsePbxProject(await readFile(projectPath, "utf8"));
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    const synchronizedRootId = "515151515151515151515151";
    const mainGroup = objects[IOS_FIXTURE_IDS.mainGroup]!;
    mainGroup.children = [
      ...(mainGroup.children as string[]).filter((id) => id !== IOS_FIXTURE_IDS.entitlementsFile),
      synchronizedRootId,
    ];
    objects[synchronizedRootId] = {
      isa: "PBXFileSystemSynchronizedRootGroup",
      path: "MyApp",
      sourceTree: "<group>",
    };
    objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
    delete objects[IOS_FIXTURE_IDS.entitlementsFile];
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      const settings = objects[id]!.buildSettings as Record<string, unknown>;
      delete settings.CODE_SIGN_ENTITLEMENTS;
    }
    await writeFile(projectPath, buildPbxProject(project));
    await rm(entitlementsPath(root));

    const plan = await planMacOSNetworkCapability(options(root, true));
    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.entitlements", operation: "create" }],
      missingEntitlementsSettings: { platform: "macos", status: "ready" },
    });
    expect((await applyMacOSNetworkCapability(plan)).status).toBe("applied");

    const afterProject = parsePbxProject(await readFile(projectPath, "utf8"));
    const afterObjects = (afterProject as unknown as { objects: PbxObjects }).objects;
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      const settings = afterObjects[id]!.buildSettings as Record<string, unknown>;
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBe("MyApp/MyApp.entitlements");
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBeUndefined();
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"]).toBeUndefined();
    }
    const entitlements = await readFile(entitlementsPath(root), "utf8");
    expect(entitlements).toContain("<key>com.apple.security.app-sandbox</key>");
    expect(entitlements).toContain("<key>com.apple.security.network.client</key>");
    expect((await planMacOSNetworkCapability(options(root))).status).toBe("satisfied");
  });

  test("creates a distinct macOS entitlement for a multiplatform target", async () => {
    const root = await temporaryRoot();
    await makeMultiplatform(root);
    await enableSandbox(root);
    await convertIOSFixtureToSynchronizedMissingEntitlements(root);
    await updateBuildSettings(root, (settings) => {
      delete settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"];
    });

    const plan = await planMacOSNetworkCapability(options(root, true));
    expect(plan).toMatchObject({
      status: "ready",
      files: [{ path: "MyApp/MyApp.mac.entitlements", operation: "create" }],
      missingEntitlementsSettings: {
        platform: "macos",
        buildSettingPath: "MyApp/MyApp.mac.entitlements",
        status: "ready",
      },
    });
    expect((await applyMacOSNetworkCapability(plan)).status).toBe("applied");

    const project = parsePbxProject(await readFile(pbxprojPath(root), "utf8"));
    const objects = (project as unknown as { objects: PbxObjects }).objects;
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      const settings = objects[id]!.buildSettings as Record<string, unknown>;
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBe("MyApp/MyApp.mac.entitlements");
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBeUndefined();
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"]).toBeUndefined();
    }
    expect(await readFile(join(root, "MyApp", "MyApp.mac.entitlements"), "utf8")).toContain(
      "com.apple.security.network.client",
    );
  });

  test("composes its candidate with a later Sign in with Apple entitlement", async () => {
    const root = await temporaryRoot();
    await enableSandbox(root);
    await removeNetworkEntitlement(root);
    const networkPlan = await planMacOSNetworkCapability(options(root));
    const network = await prepareMacOSNetworkCapabilityMutation(networkPlan);
    expect(network.status).toBe("ready");
    if (network.status !== "ready") throw new Error("Expected a network mutation.");

    const applePlan = await planIOSAppleEntitlement({
      root,
      projectPath: "MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.appTarget,
      platform: "macos",
    });
    const apple = await prepareIOSAppleEntitlementMutation(applePlan, {
      baseMutations: network.mutations,
    });
    expect(apple.status).toBe("ready");
    if (apple.status !== "ready") throw new Error("Expected a composed Apple mutation.");
    expect(apple.consumedBaseMutationPaths).toContain(entitlementsPath(root));

    const applied = await applyIOSFileTransaction(apple.mutations, [
      () => validatePreparedMacOSNetworkCapability(network),
      () => validatePreparedIOSAppleEntitlement(apple),
    ]);
    expect(applied.status).toBe("applied");
    const source = await readFile(entitlementsPath(root), "utf8");
    expect(source).toContain("com.apple.security.network.client");
    expect(source).toContain("com.apple.developer.applesignin");
  });

  test("does not serialize prepared entitlement bytes", async () => {
    const root = await temporaryRoot();
    await enableSandbox(root);
    await removeNetworkEntitlement(root);
    const prepared = await prepareMacOSNetworkCapabilityMutation(
      await planMacOSNetworkCapability(options(root)),
    );
    expect(prepared.status).toBe("ready");
    expect(JSON.stringify(prepared)).not.toContain("candidateBytes");
  });
});
