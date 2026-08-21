import { afterEach, describe, expect, test } from "bun:test";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyIOSExistingFileTransaction,
  hashIOSFileBytes,
  type IOSExistingFileMutation,
} from "./file-transaction.ts";
import {
  planIOSMissingEntitlementsSettings,
  prepareIOSMissingEntitlementsSettingsMutation,
  validateIOSMissingEntitlementsSettingsPostcondition,
} from "./entitlements-settings.ts";
import {
  planIOSSDKInstall,
  prepareIOSSDKInstallMutation,
  validateIOSSDKInstallPostcondition,
} from "./install-sdk.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS } from "./test-helpers.ts";

const SYNCHRONIZED_ROOT_ID = "515151515151515151515151";
const ANCESTOR_SYNCHRONIZED_ROOT_ID = "525252525252525252525252";
const DEVICE_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]";
const SIMULATOR_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]";
const MAC_SETTING = "CODE_SIGN_ENTITLEMENTS[sdk=macosx*]";
const temporaryDirectories: string[] = [];

interface MutableProject {
  project: ReturnType<typeof parsePbxProject>;
  objects: PbxObjects;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-entitlements-settings-"));
  temporaryDirectories.push(root);
  return root;
}

function pbxprojPath(root: string): string {
  return join(root, "MyApp.xcodeproj", "project.pbxproj");
}

function entitlementsPath(root: string): string {
  return join(root, "MyApp", "MyApp.entitlements");
}

function mutableProject(source: string): MutableProject {
  const project = parsePbxProject(source);
  const archive = project as unknown as { objects: PbxObjects };
  return { project, objects: archive.objects };
}

function settings(objects: PbxObjects, id: string): Record<string, unknown> {
  return objects[id]!.buildSettings as Record<string, unknown>;
}

async function makeSynchronizedFixture(
  options: {
    secondTarget?: boolean;
    clerkSDK?: boolean;
    shareRoot?: boolean;
    retainClassicReference?: boolean;
  } = {},
): Promise<string> {
  const root = await temporaryRoot();
  await createIOSFixture(root, {
    secondTarget: options.secondTarget,
    clerkSDK: options.clerkSDK,
  });
  const path = pbxprojPath(root);
  const graph = mutableProject(await readFile(path, "utf8"));
  const mainGroup = graph.objects[IOS_FIXTURE_IDS.mainGroup]!;
  const children = mainGroup.children as string[];
  mainGroup.children = [
    ...children.filter((id) => id !== IOS_FIXTURE_IDS.entitlementsFile),
    SYNCHRONIZED_ROOT_ID,
  ];
  graph.objects[SYNCHRONIZED_ROOT_ID] = {
    isa: "PBXFileSystemSynchronizedRootGroup",
    path: "MyApp",
    sourceTree: "<group>",
  };
  graph.objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [SYNCHRONIZED_ROOT_ID];
  if (options.shareRoot) {
    graph.objects[IOS_FIXTURE_IDS.secondTarget]!.fileSystemSynchronizedGroups = [
      SYNCHRONIZED_ROOT_ID,
    ];
  }
  for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
    const values = settings(graph.objects, id);
    delete values.CODE_SIGN_ENTITLEMENTS;
    values[MAC_SETTING] = "MyApp/MyApp.mac.entitlements";
  }
  if (!options.retainClassicReference) {
    delete graph.objects[IOS_FIXTURE_IDS.entitlementsFile];
  }
  await writeFile(path, buildPbxProject(graph.project));
  await rm(entitlementsPath(root));
  return root;
}

function options(root: string) {
  return {
    root,
    projectPath: "MyApp.xcodeproj",
    targetId: IOS_FIXTURE_IDS.appTarget,
  };
}

function blockerCodes(
  plan: Awaited<ReturnType<typeof planIOSMissingEntitlementsSettings>>,
): string[] {
  return plan.blockers.map((item) => item.code);
}

async function createCrossProjectClassicReference(root: string): Promise<void> {
  const projectPath = join(root, "Other.xcodeproj");
  await mkdir(projectPath);
  await writeFile(
    join(projectPath, "project.pbxproj"),
    `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = { };
  objectVersion = 56;
  objects = {
    616161616161616161616161 = {
      isa = PBXProject;
      mainGroup = 626262626262626262626262;
      projectDirPath = "";
      projectRoot = "";
      targets = ( );
    };
    626262626262626262626262 = {
      isa = PBXGroup;
      children = ( 636363636363636363636363, );
      sourceTree = "<group>";
    };
    636363636363636363636363 = {
      isa = PBXFileReference;
      lastKnownFileType = text.plist.entitlements;
      path = MyApp/MyApp.entitlements;
      sourceTree = "<group>";
    };
  };
  rootObject = 616161616161616161616161;
}
`,
  );
}

async function initializeGitRepository(root: string): Promise<void> {
  const child = Bun.spawn(["git", "init", "--quiet", root], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).arrayBuffer();
  const stderr = new Response(child.stderr).arrayBuffer();
  const [exitCode] = await Promise.all([child.exited, stdout, stderr]);
  if (exitCode !== 0) throw new Error("Could not initialize the test Git repository.");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("missing iOS entitlements build settings", () => {
  test("adds SDK-qualified settings to every selected configuration and is byte-idempotent", async () => {
    const root = await makeSynchronizedFixture({ secondTarget: true });
    await chmod(pbxprojPath(root), 0o640);
    const before = await readFile(pbxprojPath(root));
    const beforeGraph = mutableProject(before.toString());
    const secondBefore = JSON.stringify({
      debug: beforeGraph.objects[IOS_FIXTURE_IDS.secondDebug],
      release: beforeGraph.objects[IOS_FIXTURE_IDS.secondRelease],
    });

    const plan = await planIOSMissingEntitlementsSettings(options(root));
    expect(plan).toMatchObject({
      status: "ready",
      entitlementsPath: "MyApp/MyApp.entitlements",
      buildSettingPath: "MyApp/MyApp.entitlements",
      synchronizedRootPath: "MyApp",
      configurationIds: [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease],
      blockers: [],
    });
    const prepared = await prepareIOSMissingEntitlementsSettingsMutation(plan);
    expect(prepared.status).toBe("ready");
    expect(JSON.stringify(prepared)).not.toContain("candidateBytes");
    if (prepared.status !== "ready") throw new Error("Expected a prepared mutation.");
    expect(prepared.mutation.originalBytes).toEqual(before);

    const result = await applyIOSExistingFileTransaction(
      [prepared.mutation],
      [() => validateIOSMissingEntitlementsSettingsPostcondition(plan)],
    );
    expect(result.status).toBe("applied");
    expect((await stat(pbxprojPath(root))).mode & 0o777).toBe(0o640);
    const after = await readFile(pbxprojPath(root));
    const afterGraph = mutableProject(after.toString());
    for (const id of [IOS_FIXTURE_IDS.targetDebug, IOS_FIXTURE_IDS.targetRelease]) {
      expect(settings(afterGraph.objects, id)).toMatchObject({
        [DEVICE_SETTING]: "MyApp/MyApp.entitlements",
        [SIMULATOR_SETTING]: "MyApp/MyApp.entitlements",
        [MAC_SETTING]: "MyApp/MyApp.mac.entitlements",
      });
    }
    expect(
      JSON.stringify({
        debug: afterGraph.objects[IOS_FIXTURE_IDS.secondDebug],
        release: afterGraph.objects[IOS_FIXTURE_IDS.secondRelease],
      }),
    ).toBe(secondBefore);
    expect(await Bun.file(entitlementsPath(root)).exists()).toBe(false);

    const rerun = await planIOSMissingEntitlementsSettings(options(root));
    expect(rerun.status).toBe("satisfied");
    expect((await prepareIOSMissingEntitlementsSettingsMutation(rerun)).status).toBe("satisfied");
    expect(await readFile(pbxprojPath(root))).toEqual(after);
  });

  test("composes with an SDK candidate into one project mutation", async () => {
    const root = await makeSynchronizedFixture({ clerkSDK: false });
    const entitlementsPlan = await planIOSMissingEntitlementsSettings(options(root));
    const sdkPlan = await planIOSSDKInstall(options(root));
    const sdk = await prepareIOSSDKInstallMutation(sdkPlan);
    expect(sdk.status).toBe("ready");
    if (sdk.status !== "ready") throw new Error("Expected an SDK mutation.");

    const combined = await prepareIOSMissingEntitlementsSettingsMutation(
      entitlementsPlan,
      sdk.mutation,
    );
    expect(combined.status).toBe("ready");
    if (combined.status !== "ready") throw new Error("Expected a combined mutation.");
    expect(combined.mutation.path).toBe(sdk.mutation.path);
    expect(combined.mutation.originalHash).toBe(sdk.mutation.originalHash);
    expect(combined.mutation.candidateHash).not.toBe(sdk.mutation.candidateHash);

    const result = await applyIOSExistingFileTransaction(
      [combined.mutation],
      [
        () => validateIOSSDKInstallPostcondition(sdk.plan),
        () => validateIOSMissingEntitlementsSettingsPostcondition(entitlementsPlan),
      ],
    );
    expect(result.status).toBe("applied");
    expect(await validateIOSSDKInstallPostcondition(sdk.plan)).toBe(true);
    expect(await validateIOSMissingEntitlementsSettingsPostcondition(entitlementsPlan)).toBe(true);
  });

  test("produces deterministic candidate bytes", async () => {
    const firstRoot = await makeSynchronizedFixture();
    const secondRoot = await makeSynchronizedFixture();
    const first = await prepareIOSMissingEntitlementsSettingsMutation(
      await planIOSMissingEntitlementsSettings(options(firstRoot)),
    );
    const second = await prepareIOSMissingEntitlementsSettingsMutation(
      await planIOSMissingEntitlementsSettings(options(secondRoot)),
    );
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") {
      throw new Error("Expected deterministic mutations.");
    }
    expect(first.mutation.candidateBytes).toEqual(second.mutation.candidateBytes);
  });

  test("blocks missing, ambiguous, shared, and generated synchronized-root ownership", async () => {
    const missingRoot = await temporaryRoot();
    await createIOSFixture(missingRoot, { releaseEntitlements: false });
    const missingGraph = mutableProject(await readFile(pbxprojPath(missingRoot), "utf8"));
    delete settings(missingGraph.objects, IOS_FIXTURE_IDS.targetDebug).CODE_SIGN_ENTITLEMENTS;
    delete missingGraph.objects[IOS_FIXTURE_IDS.entitlementsFile];
    missingGraph.objects[IOS_FIXTURE_IDS.mainGroup]!.children = (
      missingGraph.objects[IOS_FIXTURE_IDS.mainGroup]!.children as string[]
    ).filter((id) => id !== IOS_FIXTURE_IDS.entitlementsFile);
    await writeFile(pbxprojPath(missingRoot), buildPbxProject(missingGraph.project));
    await rm(entitlementsPath(missingRoot));
    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(missingRoot)))).toContain(
      "missing-synchronized-root",
    );

    const ambiguousRoot = await makeSynchronizedFixture();
    const ambiguousGraph = mutableProject(await readFile(pbxprojPath(ambiguousRoot), "utf8"));
    const secondRootId = "525252525252525252525252";
    ambiguousGraph.objects[secondRootId] = {
      isa: "PBXFileSystemSynchronizedRootGroup",
      path: "Other",
      sourceTree: "<group>",
    };
    ambiguousGraph.objects[IOS_FIXTURE_IDS.mainGroup]!.children = [
      ...(ambiguousGraph.objects[IOS_FIXTURE_IDS.mainGroup]!.children as string[]),
      secondRootId,
    ];
    ambiguousGraph.objects[IOS_FIXTURE_IDS.appTarget]!.fileSystemSynchronizedGroups = [
      SYNCHRONIZED_ROOT_ID,
      secondRootId,
    ];
    await writeFile(pbxprojPath(ambiguousRoot), buildPbxProject(ambiguousGraph.project));
    expect(
      blockerCodes(await planIOSMissingEntitlementsSettings(options(ambiguousRoot))),
    ).toContain("ambiguous-synchronized-root");

    const sharedRoot = await makeSynchronizedFixture({ secondTarget: true, shareRoot: true });
    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(sharedRoot)))).toContain(
      "shared-synchronized-root",
    );

    const generatedRoot = await makeSynchronizedFixture();
    await writeFile(join(generatedRoot, "project.yml"), "name: MyApp\n");
    expect(
      blockerCodes(await planIOSMissingEntitlementsSettings(options(generatedRoot))),
    ).toContain("generated-project");
  });

  test.each(["regular", "directory", "symlink", "hardlink"] as const)(
    "refuses an unreferenced %s destination collision",
    async (kind) => {
      const root = await makeSynchronizedFixture();
      const destination = entitlementsPath(root);
      if (kind === "regular") await writeFile(destination, "existing");
      if (kind === "directory") await mkdir(destination);
      if (kind === "symlink") {
        const source = join(root, "MyApp", "Other.entitlements");
        await writeFile(source, "existing");
        await symlink(source, destination);
      }
      if (kind === "hardlink") {
        const source = join(root, "MyApp", "Other.entitlements");
        await writeFile(source, "existing");
        await link(source, destination);
      }
      expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(root)))).toContain(
        "entitlements-destination-exists",
      );
    },
  );

  test("refuses a classic file reference and partial iOS settings", async () => {
    const referenceRoot = await makeSynchronizedFixture({ retainClassicReference: true });
    expect(
      blockerCodes(await planIOSMissingEntitlementsSettings(options(referenceRoot))),
    ).toContain("entitlements-destination-exists");

    const partialRoot = await makeSynchronizedFixture();
    const graph = mutableProject(await readFile(pbxprojPath(partialRoot), "utf8"));
    settings(graph.objects, IOS_FIXTURE_IDS.targetDebug)[DEVICE_SETTING] =
      "MyApp/MyApp.entitlements";
    await writeFile(pbxprojPath(partialRoot), buildPbxProject(graph.project));
    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(partialRoot)))).toContain(
      "conflicting-entitlements-settings",
    );
  });

  test("refuses an entitlements destination referenced by another target", async () => {
    const root = await makeSynchronizedFixture({ secondTarget: true });
    const graph = mutableProject(await readFile(pbxprojPath(root), "utf8"));
    for (const id of [IOS_FIXTURE_IDS.secondDebug, IOS_FIXTURE_IDS.secondRelease]) {
      settings(graph.objects, id).CODE_SIGN_ENTITLEMENTS = "MyApp/MyApp.entitlements";
    }
    await writeFile(pbxprojPath(root), buildPbxProject(graph.project));

    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(root)))).toContain(
      "shared-entitlements-destination",
    );
  });

  test("refuses a destination represented by a classic reference in another project", async () => {
    const root = await makeSynchronizedFixture();
    await createCrossProjectClassicReference(root);

    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(root)))).toContain(
      "entitlements-destination-exists",
    );
  });

  test("refuses a sibling synchronized root that is an ancestor of the destination", async () => {
    const root = await makeSynchronizedFixture({ secondTarget: true });
    const graph = mutableProject(await readFile(pbxprojPath(root), "utf8"));
    graph.objects[ANCESTOR_SYNCHRONIZED_ROOT_ID] = {
      isa: "PBXFileSystemSynchronizedRootGroup",
      path: ".",
      sourceTree: "<group>",
    };
    graph.objects[IOS_FIXTURE_IDS.mainGroup]!.children = [
      ...(graph.objects[IOS_FIXTURE_IDS.mainGroup]!.children as string[]),
      ANCESTOR_SYNCHRONIZED_ROOT_ID,
    ];
    graph.objects[IOS_FIXTURE_IDS.secondTarget]!.fileSystemSynchronizedGroups = [
      ANCESTOR_SYNCHRONIZED_ROOT_ID,
    ];
    await writeFile(pbxprojPath(root), buildPbxProject(graph.project));

    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(root)))).toContain(
      "shared-synchronized-root",
    );
  });

  test("blocks a Git-ignored destination and honors a targeted negation", async () => {
    const ignoredRoot = await makeSynchronizedFixture();
    await initializeGitRepository(ignoredRoot);
    await writeFile(join(ignoredRoot, ".gitignore"), "*.entitlements\n");
    expect(blockerCodes(await planIOSMissingEntitlementsSettings(options(ignoredRoot)))).toContain(
      "ignored-entitlements-destination",
    );

    const includedRoot = await makeSynchronizedFixture();
    await initializeGitRepository(includedRoot);
    await writeFile(
      join(includedRoot, ".gitignore"),
      "*.entitlements\n!MyApp/MyApp.entitlements\n",
    );
    expect(await planIOSMissingEntitlementsSettings(options(includedRoot))).toMatchObject({
      status: "ready",
      blockers: [],
    });
  });

  test("postcondition rejects replacement of the synchronized root directory", async () => {
    const root = await makeSynchronizedFixture();
    const plan = await planIOSMissingEntitlementsSettings(options(root));
    const prepared = await prepareIOSMissingEntitlementsSettingsMutation(plan);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected a prepared mutation.");
    expect((await applyIOSExistingFileTransaction([prepared.mutation], [() => true])).status).toBe(
      "applied",
    );

    const sourcePath = join(root, "MyApp", "MyAppApp.swift");
    const source = await readFile(sourcePath);
    await rename(join(root, "MyApp"), join(root, "MyApp-replaced"));
    await mkdir(join(root, "MyApp"));
    await writeFile(sourcePath, source);

    expect(await validateIOSMissingEntitlementsSettingsPostcondition(plan)).toBe(false);
  });

  test("treats project, destination, and base-mutation races as stale", async () => {
    const projectRoot = await makeSynchronizedFixture();
    const projectPlan = await planIOSMissingEntitlementsSettings(options(projectRoot));
    const newerProject = await readFile(pbxprojPath(projectRoot));
    await appendFile(pbxprojPath(projectRoot), "\n// newer\n");
    expect((await prepareIOSMissingEntitlementsSettingsMutation(projectPlan)).status).toBe("stale");
    expect(await readFile(pbxprojPath(projectRoot))).not.toEqual(newerProject);

    const destinationRoot = await makeSynchronizedFixture();
    const destinationPlan = await planIOSMissingEntitlementsSettings(options(destinationRoot));
    await writeFile(entitlementsPath(destinationRoot), "newer");
    expect((await prepareIOSMissingEntitlementsSettingsMutation(destinationPlan)).status).toBe(
      "stale",
    );
    expect(await readFile(entitlementsPath(destinationRoot), "utf8")).toBe("newer");

    const baseRoot = await makeSynchronizedFixture();
    const basePlan = await planIOSMissingEntitlementsSettings(options(baseRoot));
    const bytes = new Uint8Array(await readFile(pbxprojPath(baseRoot)));
    const invalidBase: IOSExistingFileMutation = {
      path: join(baseRoot, "Other.xcodeproj", "project.pbxproj"),
      originalBytes: bytes,
      originalHash: hashIOSFileBytes(bytes),
      candidateBytes: bytes,
      candidateHash: hashIOSFileBytes(bytes),
      mode: 0o644,
    };
    expect(
      (await prepareIOSMissingEntitlementsSettingsMutation(basePlan, invalidBase)).status,
    ).toBe("stale");
  });
});
