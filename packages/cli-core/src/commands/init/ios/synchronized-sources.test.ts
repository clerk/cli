import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectIOSProject } from "./inspect.ts";
import type { PbxObjects } from "./pbx.ts";
import { createIOSFixture, IOS_FIXTURE_IDS as IDS } from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  directory: string,
  options: {
    excluded?: boolean;
    directoryException?: boolean;
    opaque?: boolean;
    fileTypes?: unknown;
    filename?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clerk-synchronized-sources-"));
  roots.push(root);
  await createIOSFixture(root);
  const source = join("MyApp", directory, options.filename ?? "Bootstrap.swift");
  await mkdir(dirname(join(root, source)), { recursive: true });
  await Bun.write(
    join(root, source),
    'import ClerkKit\nfunc configureExistingClerk() { Clerk.configure(publishableKey: "pk_test_existing") }\n',
  );
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const project = parse(await Bun.file(path).text());
  const objects = project.objects as PbxObjects;
  objects.sync = {
    isa: "PBXFileSystemSynchronizedRootGroup",
    path: "MyApp",
    sourceTree: "<group>",
    explicitFolders: options.opaque ? [directory] : [],
    explicitFileTypes: options.fileTypes ?? {},
    exceptions: options.excluded || options.directoryException ? ["exception"] : [],
  };
  (objects[IDS.mainGroup]!.children as string[]).push("sync");
  objects[IDS.appTarget]!.fileSystemSynchronizedGroups = ["sync"];
  if (options.excluded || options.directoryException) {
    objects.exception = {
      isa: "PBXFileSystemSynchronizedBuildFileExceptionSet",
      target: IDS.appTarget,
      membershipExceptions: [
        options.directoryException ? directory : `${directory}/Bootstrap.swift`,
      ],
    };
  }
  await Bun.write(path, build(project));
  return { root, source };
}

test.each([
  "build",
  "Pods",
  "SourcePackages",
  ".hidden",
  ".build",
  ".swiftpm",
  "Carthage",
  "DerivedData",
])("includes synchronized Swift sources below %s", async (directory) => {
  const { root, source } = await fixture(directory);
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift).toMatchObject({
    evidenceComplete: true,
    sourceFilesScanned: 2,
    configureCalls: [expect.objectContaining({ path: source })],
  });
});

test.each(["build", ".hidden"])("honors an explicit file exclusion below %s", async (directory) => {
  const { root } = await fixture(directory, { excluded: true });
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift).toMatchObject({
    evidenceComplete: true,
    sourceFilesScanned: 1,
    configureCalls: [],
  });
});

test.each([
  ".git",
  "Templates.bundle",
  "Docs.docc",
  "en.lproj",
  "Demo.playground",
  "Assets.xcassets",
  "Model.xcdatamodeld",
  "Page.xcplaygroundpage",
])("does not compile synchronized Swift inside %s", async (directory) => {
  const { root } = await fixture(directory);
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift).toMatchObject({
    evidenceComplete: true,
    sourceFilesScanned: 1,
    configureCalls: [],
  });
});

test("honors an explicitly opaque synchronized subfolder", async () => {
  const { root } = await fixture("Templates", { opaque: true });
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift).toMatchObject({
    evidenceComplete: true,
    sourceFilesScanned: 1,
    configureCalls: [],
  });
});

test.each([{ "Templates.bundle": "folder" }, "unresolved"])(
  "keeps unmodeled synchronized file-type overrides incomplete: %j",
  async (fileTypes) => {
    const { root } = await fixture("Templates.bundle", { fileTypes });
    const result = await inspectIOSProject(root);
    expect(result.appTargets[0]?.swift.evidenceComplete).toBe(false);
  },
);

test("recognizes mixed-case Swift extensions below hidden folders", async () => {
  const { root, source } = await fixture(".hidden", { filename: "Bootstrap.SwIfT" });
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift.configureCalls).toEqual([
    expect.objectContaining({ path: source }),
  ]);
});

test("retains incomplete discovery when a synchronized folder exceeds the traversal bound", async () => {
  const { root } = await fixture(Array(26).fill(".hidden").join("/"));
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(false);
});

test("does not treat a directory membership exception as proof its sources are excluded", async () => {
  const { root } = await fixture("build", { directoryException: true });
  const result = await inspectIOSProject(root);
  expect(result.appTargets[0]?.swift.evidenceComplete).toBe(false);
});
