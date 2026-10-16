import { build, parse } from "@bacons/xcode/json";
import { IOS_FIXTURE_IDS as ids } from "./test-helpers.ts";
import { starterApp, STARTER_VIEW } from "./starter.ts";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyXCProjValue } from "./xcproj.ts";

// Converts only disposable fixtures, using the repository's Xcode JSON example.
export async function convertFixtureToXCProj(root: string, platform: "ios" | "macos") {
  let source = await readFile(
    join(
      import.meta.dir,
      "../../../../../../test/e2e/fixtures/ios-json/MyApp.xcodeproj/project.xcproj",
    ),
    "utf8",
  );
  if (platform === "macos") {
    for (const [key, value] of Object.entries({
      MACOSX_DEPLOYMENT_TARGET: "14.0",
      SUPPORTED_PLATFORMS: "macosx",
      ENABLE_APP_SANDBOX: "YES",
    }))
      source = applyXCProjValue(source, ["targets", 0, "build-settings", key], value);
    source = applyXCProjValue(source, ["build-settings", "SDKROOT"], "macosx");
  }
  await writeFile(join(root, "MyApp.xcodeproj/project.xcproj"), source);
  await unlink(join(root, "MyApp.xcodeproj/project.pbxproj"));
}

export async function useStarterSources(root: string) {
  const path = join(root, "MyApp.xcodeproj/project.pbxproj");
  const graph = parse(await readFile(path, "utf8")),
    objects = graph.objects as Record<string, any>;
  objects["515151515151515151515151"] = {
    isa: "PBXFileReference",
    lastKnownFileType: "sourcecode.swift",
    path: "ContentView.swift",
    sourceTree: "<group>",
  };
  objects["525252525252525252525252"] = {
    isa: "PBXBuildFile",
    fileRef: "515151515151515151515151",
  };
  objects[ids.appGroup].children.push("515151515151515151515151");
  objects[ids.sourcesPhase].files.push("525252525252525252525252");
  for (const id of [ids.targetDebug, ids.targetRelease])
    Object.assign(objects[id].buildSettings, {
      SWIFT_VERSION: "6.0",
      PRODUCT_NAME: "$(TARGET_NAME)",
      ALWAYS_SEARCH_USER_PATHS: "NO",
    });
  await writeFile(path, build(graph));
  await writeFile(
    join(root, "MyApp/MyAppApp.swift"),
    "// Preserve the project header\n" + starterApp("MyApp"),
  );
  await writeFile(join(root, "MyApp/ContentView.swift"), STARTER_VIEW);
}
