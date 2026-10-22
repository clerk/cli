import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@bacons/xcode/json";
import * as files from "./files.ts";
import { STARTER_VIEW, starterApp } from "./starter.ts";
import {
  starterProjectFile,
  starterProjectFiles,
  writeStarterProject,
  type ApplePlatform,
  type StarterProject,
} from "./starter-project.ts";

const project = (platform: ApplePlatform, overrides: Partial<StarterProject> = {}) => ({
  name: "MyApp",
  bundleIdentifier: "com.example.MyApp",
  teamId: "ABCDE12345",
  platform,
  ...overrides,
});

function graph(platform: ApplePlatform, overrides: Partial<StarterProject> = {}) {
  const parsed = parse(starterProjectFile(project(platform, overrides)));
  const objects = parsed.objects as Record<string, any>;
  const root = objects[parsed.rootObject!];
  const target = objects[root.targets[0]];
  const configurations = (listId: string) =>
    objects[listId].buildConfigurations.map((id: string) => objects[id]);
  return {
    objects,
    root,
    target,
    targetConfigurations: configurations(target.buildConfigurationList),
    projectConfigurations: configurations(root.buildConfigurationList),
  };
}

const PLATFORMS = ["ios", "macos"] as const;

describe("starterProjectFile", () => {
  test.each([...PLATFORMS])("%s has one app target on a folder-synchronized group", (platform) => {
    const { objects, root, target } = graph(platform);
    expect(root.targets).toHaveLength(1);
    expect(target.productType).toBe("com.apple.product-type.application");
    expect(target.name).toBe("MyApp");
    const main = objects[root.mainGroup];
    const synced = main.children
      .map((id: string) => objects[id])
      .filter((group: any) => group.isa === "PBXFileSystemSynchronizedRootGroup");
    expect(synced).toHaveLength(1);
    expect(synced[0].path).toBe("MyApp");
    expect(synced[0].exceptions).toBeUndefined();
    expect(target.fileSystemSynchronizedGroups).toHaveLength(1);
    expect(
      target.buildPhases.some((id: string) => objects[id].isa === "PBXShellScriptBuildPhase"),
    ).toBe(false);
  });

  // Native setup reads the Bundle ID and App ID Prefix from these, the same in every configuration.
  test.each([...PLATFORMS])("%s sets the identity setup resolves without asking", (platform) => {
    const { targetConfigurations } = graph(platform);
    expect(targetConfigurations.map((config: any) => config.name)).toEqual(["Debug", "Release"]);
    for (const { buildSettings } of targetConfigurations) {
      expect(buildSettings.PRODUCT_BUNDLE_IDENTIFIER).toBe("com.example.MyApp");
      expect(buildSettings.DEVELOPMENT_TEAM).toBe("ABCDE12345");
      expect(buildSettings.GENERATE_INFOPLIST_FILE).toBe("YES");
      expect(buildSettings.INFOPLIST_FILE).toBeUndefined();
      expect(buildSettings.CODE_SIGN_STYLE).toBe("Automatic");
    }
  });

  test("iOS targets the supported floor and generates a launch screen", () => {
    const { targetConfigurations, projectConfigurations } = graph("ios");
    for (const { buildSettings } of projectConfigurations) {
      expect(buildSettings.SDKROOT).toBe("iphoneos");
      expect(buildSettings.IPHONEOS_DEPLOYMENT_TARGET).toBe("17.0");
    }
    for (const { buildSettings } of targetConfigurations) {
      expect(buildSettings.INFOPLIST_KEY_UILaunchScreen_Generation).toBe("YES");
      expect(buildSettings.TARGETED_DEVICE_FAMILY).toBe("1,2");
    }
  });

  test("macOS targets the supported floor in the App Sandbox", () => {
    const { targetConfigurations, projectConfigurations } = graph("macos");
    for (const { buildSettings } of projectConfigurations) {
      expect(buildSettings.SDKROOT).toBe("macosx");
      expect(buildSettings.MACOSX_DEPLOYMENT_TARGET).toBe("14.0");
    }
    for (const { buildSettings } of targetConfigurations) {
      expect(buildSettings.ENABLE_APP_SANDBOX).toBe("YES");
      expect(buildSettings.INFOPLIST_KEY_UILaunchScreen_Generation).toBeUndefined();
    }
  });

  test.each([...PLATFORMS])("%s builds only the active architecture in Debug", (platform) => {
    const [debug, release] = graph(platform).projectConfigurations;
    expect(debug.buildSettings.ONLY_ACTIVE_ARCH).toBe("YES");
    expect(release.buildSettings.ONLY_ACTIVE_ARCH).toBeUndefined();
  });

  test("quotes a Bundle ID that needs it", () => {
    const { targetConfigurations } = graph("ios", { bundleIdentifier: "com.my-company.MyApp" });
    expect(targetConfigurations[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER).toBe(
      "com.my-company.MyApp",
    );
  });
});

describe("starterProjectFiles", () => {
  test.each([...PLATFORMS])("%s writes the exact template sources setup recognizes", (platform) => {
    const files = starterProjectFiles(project(platform));
    expect(Object.keys(files).sort()).toEqual([
      "MyApp.xcodeproj/project.pbxproj",
      "MyApp/Assets.xcassets/AccentColor.colorset/Contents.json",
      "MyApp/Assets.xcassets/AppIcon.appiconset/Contents.json",
      "MyApp/Assets.xcassets/Contents.json",
      "MyApp/ContentView.swift",
      "MyApp/MyAppApp.swift",
    ]);
    expect(files["MyApp/MyAppApp.swift"]!.endsWith(starterApp("MyApp"))).toBe(true);
    expect(files["MyApp/ContentView.swift"]!.endsWith(STARTER_VIEW)).toBe(true);
  });

  test.each([
    ["ios", "ios"],
    ["macos", "mac"],
  ] as const)("%s app icon uses the %s idiom", (platform, idiom) => {
    const icon = JSON.parse(
      starterProjectFiles(project(platform))[
        "MyApp/Assets.xcassets/AppIcon.appiconset/Contents.json"
      ]!,
    );
    expect(icon.images.length).toBeGreaterThan(0);
    expect(
      icon.images.every((image: any) =>
        idiom === "ios" ? image.platform === "ios" : image.idiom === "mac",
      ),
    ).toBe(true);
  });
});

describe("writeStarterProject", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("writes every file into a new directory", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clerk-starter-"));
    const directory = join(tmp, "MyApp");
    await writeStarterProject(directory, project("ios"));
    for (const [path, content] of Object.entries(starterProjectFiles(project("ios"))))
      expect(readFileSync(join(directory, path), "utf8")).toBe(content);
  });

  test("refuses an existing directory and leaves it untouched", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clerk-starter-"));
    const directory = join(tmp, "MyApp");
    mkdirSync(directory);
    writeFileSync(join(directory, "keep.txt"), "mine");
    await expect(writeStarterProject(directory, project("ios"))).rejects.toThrow();
    expect(readFileSync(join(directory, "keep.txt"), "utf8")).toBe("mine");
  });

  test("removes a partly written project when a write fails", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clerk-starter-"));
    const directory = join(tmp, "MyApp");
    const original = files.createFile;
    let writes = 0;
    const createFile = spyOn(files, "createFile").mockImplementation(async (...args) => {
      if (++writes === 3) throw new Error("disk full");
      return original(...args);
    });
    try {
      await expect(writeStarterProject(directory, project("ios"))).rejects.toThrow("disk full");
      expect(existsSync(directory)).toBe(false);
    } finally {
      createFile.mockRestore();
    }
  });
});
