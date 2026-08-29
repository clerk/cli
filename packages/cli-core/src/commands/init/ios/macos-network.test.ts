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
import { createIOSFixture, IOS_FIXTURE_IDS, treeDigest } from "./test-helpers.ts";

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
