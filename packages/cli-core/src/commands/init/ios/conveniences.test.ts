import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture } from "./test-helpers.ts";
import { selectApplication, SelectionNeeded } from "./discovery.ts";
import { discoverBundleIdentifier } from "./identity.ts";
import { createFile, replaceProject, rollbackFiles, snapshotFile } from "./files.ts";
import { inspectSelectedProject } from "./xcode.ts";
import { planStarter } from "./starter.ts";
import { convertFixtureToXCProj, useStarterSources } from "./setup-test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await realpath(await mkdtemp(join(tmpdir(), "clerk-conveniences-")));
  roots.push(value);
  return value;
}
async function inspection(format: "pbxproj" | "xcproj" = "pbxproj") {
  const path = await root();
  await createIOSFixture(path, { clerkSDK: false, includeKey: false });
  await useStarterSources(path);
  if (format === "xcproj") await convertFixtureToXCProj(path, "ios");
  return inspectSelectedProject(
    { root: path, products: "ui", minimumVersion: "1.0.0" },
    async (command) =>
      JSON.stringify([
        {
          target: "MyApp",
          buildSettings: {
            TARGET_NAME: "MyApp",
            PROJECT_FILE_PATH: join(path, "MyApp.xcodeproj"),
            CONFIGURATION: command[command.indexOf("-configuration") + 1],
            PLATFORM_NAME: "iphoneos",
            PRODUCT_TYPE: "com.apple.product-type.application",
            IPHONEOS_DEPLOYMENT_TARGET: "17.0",
            PRODUCT_BUNDLE_IDENTIFIER: "com.example.App",
            GENERATE_INFOPLIST_FILE: "YES",
          },
        },
      ]),
  );
}

test("workspace discovery selects the sole nested app and presents one picker when apps are ambiguous", async () => {
  const path = await root();
  await mkdir(join(path, "Apps"));
  await createIOSFixture(join(path, "Apps/First"), { clerkSDK: false });
  await mkdir(join(path, "App.xcworkspace"));
  const workspace = join(path, "App.xcworkspace/contents.xcworkspacedata");
  await writeFile(
    workspace,
    '<Workspace><Group name="Logical group"><Group location="group:Apps"><FileRef location="group:First/MyApp.xcodeproj"/></Group></Group></Workspace>',
  );
  const selected = await selectApplication(path, undefined, undefined, async () => {
    throw new Error("Unnecessary picker");
  });
  expect(selected.project).toBe("Apps/First/MyApp.xcodeproj");
  await createIOSFixture(join(path, "Apps/Second"), { clerkSDK: false });
  await convertFixtureToXCProj(join(path, "Apps/Second"), "ios");
  await writeFile(
    workspace,
    '<Workspace><Group location="group:Apps"><FileRef location="group:First/MyApp.xcodeproj"/><FileRef location="group:Second/MyApp.xcodeproj"/></Group></Workspace>',
  );
  await expect(selectApplication(path)).rejects.toBeInstanceOf(SelectionNeeded);
  let calls = 0;
  const picked = await selectApplication(path, "App.xcworkspace", undefined, async (choices) => {
    calls++;
    expect(choices).toHaveLength(2);
    return choices[1]!;
  });
  expect(calls).toBe(1);
  expect(picked.format).toBe("xcproj");
  expect(picked.project).toBe("Apps/Second/MyApp.xcodeproj");
});

test("external and symlinked workspace projects are skipped without hiding the root app", async () => {
  const path = await root(),
    outside = await root();
  await createIOSFixture(outside, { clerkSDK: false });
  await mkdir(join(path, "App.xcworkspace"));
  const workspace = join(path, "App.xcworkspace/contents.xcworkspacedata");
  await writeFile(
    workspace,
    `<Workspace><FileRef location="absolute:${outside}/MyApp.xcodeproj"/></Workspace>`,
  );
  await expect(selectApplication(path)).rejects.toThrow("none found");
  await symlink(join(outside, "MyApp.xcodeproj"), join(path, "Linked.xcodeproj"));
  await writeFile(workspace, '<Workspace><FileRef location="group:Linked.xcodeproj"/></Workspace>');
  await expect(selectApplication(path)).rejects.toThrow("none found");
  await createIOSFixture(path, { clerkSDK: false });
  expect((await selectApplication(path)).project).toBe("MyApp.xcodeproj");
});

test("workspace discovery skips missing projects even when their parent folder is absent", async () => {
  const path = await root();
  await createIOSFixture(path, { clerkSDK: false });
  await mkdir(join(path, "App.xcworkspace"));
  await writeFile(
    join(path, "App.xcworkspace/contents.xcworkspacedata"),
    '<Workspace><FileRef location="group:MyApp.xcodeproj"/><FileRef location="group:Missing.xcodeproj"/><FileRef location="group:Pods/Pods.xcodeproj"/></Workspace>',
  );
  expect((await selectApplication(path)).project).toBe("MyApp.xcodeproj");
  expect((await selectApplication(path, "App.xcworkspace")).project).toBe("MyApp.xcodeproj");
  // A project below a symlink is never edited, but it doesn't hide the root app either.
  await symlink(await root(), join(path, "Pods"));
  expect((await selectApplication(path)).project).toBe("MyApp.xcodeproj");
});

test("Bundle ID discovery handles ordinary generated and explicit plists, but not conflicting configurations", async () => {
  const found = await inspection();
  expect(await discoverBundleIdentifier(found)).toBe("com.example.App");
  found.contexts[1]!.settings.PRODUCT_BUNDLE_IDENTIFIER = "com.example.Release";
  expect(await discoverBundleIdentifier(found)).toBeUndefined();
  found.contexts[1]!.settings.PRODUCT_BUNDLE_IDENTIFIER = "com.example.App";
  await writeFile(
    join(found.input.selection.root, "MyApp/Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string></dict></plist>',
  );
  for (const context of found.contexts) {
    context.settings.GENERATE_INFOPLIST_FILE = "NO";
    context.settings.INFOPLIST_FILE = "MyApp/Info.plist";
  }
  expect(await discoverBundleIdentifier(found)).toBe("com.example.App");
  found.contexts[1]!.settings.INFOPLIST_PREPROCESS = "YES";
  expect(await discoverBundleIdentifier(found)).toBeUndefined();
});

test("a partial Info.plist merged into a generated one uses the build setting's Bundle ID", async () => {
  const found = await inspection();
  await writeFile(
    join(found.input.selection.root, "MyApp/Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleURLTypes</key><array/></dict></plist>',
  );
  for (const context of found.contexts) {
    context.settings.GENERATE_INFOPLIST_FILE = "YES";
    context.settings.INFOPLIST_FILE = "MyApp/Info.plist";
  }
  expect(await discoverBundleIdentifier(found)).toBe("com.example.App");
  for (const context of found.contexts) context.settings.GENERATE_INFOPLIST_FILE = "NO";
  expect(await discoverBundleIdentifier(found)).toBeUndefined();
});

test("ordinary recovery restores previous bytes and removes newly created files while preserving later edits", async () => {
  const path = await root();
  await writeFile(join(path, "existing"), "original");
  const before = await snapshotFile(path, "existing");
  await replaceProject(path, before, "CLI edit");
  const after = await snapshotFile(path, "existing");
  await createFile(path, "new", "CLI file");
  const created = await snapshotFile(path, "new");
  const recovery = await rollbackFiles(path, [{ before, after }, { after: created }]);
  expect(recovery).toEqual({ restored: ["new", "existing"], needsReview: [] });
  expect(await readFile(join(path, "existing"), "utf8")).toBe("original");
  await expect(readFile(join(path, "new"))).rejects.toThrow();
  const current = await snapshotFile(path, "existing");
  await replaceProject(path, current, "CLI second edit");
  const second = await snapshotFile(path, "existing");
  await writeFile(join(path, "existing"), "User's later edit");
  expect(await rollbackFiles(path, [{ before: current, after: second }])).toEqual({
    restored: [],
    needsReview: ["existing"],
  });
  expect(await readFile(join(path, "existing"), "utf8")).toBe("User's later edit");
});

test("a replacement that doesn't complete leaves no backup behind", async () => {
  const path = await root();
  await writeFile(join(path, "existing"), "original");
  const before = await snapshotFile(path, "existing");
  const rename = spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("disk full"));
  try {
    await expect(replaceProject(path, before, "CLI edit")).rejects.toThrow("disk full");
  } finally {
    rename.mockRestore();
  }
  expect(await readFile(join(path, "existing"), "utf8")).toBe("original");
  expect(await readdir(path)).toEqual(["existing"]);
});

for (const format of ["pbxproj", "xcproj"] as const)
  test(`${format}: starter recipe is limited to unchanged templates and explicit UI intent`, async () => {
    const found = await inspection(format);
    const header = "// Created for the important release\n// import notes\n";
    for (const file of ["MyAppApp.swift", "ContentView.swift"]) {
      const path = join(found.input.selection.root, "MyApp", file);
      await writeFile(path, header + (await readFile(path, "utf8")));
    }
    const key = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
    const plan = await planStarter(found, key, true);
    expect(plan.actions).toHaveLength(2);
    for (const action of plan.actions) {
      expect("content" in action && action.content?.startsWith(header)).toBe(true);
      expect("content" in action && action.content).toContain("\nimport SwiftUI\n");
    }
    expect(plan.tasks).toEqual(["initialize-clerk", "swiftui-environment", "optional-sign-in-ui"]);
    expect((await planStarter(found, key, false)).actions).toHaveLength(1);
    const path = join(found.input.selection.root, "MyApp/ContentView.swift");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace('"Hello, world!"', '"My custom app"'),
    );
    expect((await planStarter(found, key, true)).actions).toEqual([]);
    expect((await planStarter(found, undefined, true)).actions).toEqual([]);
  });
