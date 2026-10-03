import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, parse } from "@bacons/xcode/json";
import {
  createIOSFixture,
  IOS_FIXTURE_IDS as ids,
} from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { prepareSetup } from "../../packages/cli-core/src/commands/init/ios/workflow.ts";

// Real xcodebuild decides whether another target shares the app's entitlements,
// however its value is set. A CocoaPods-style xcconfig without entitlements stays
// automatic; one that resolves to the app's file falls back to manual setup.
const cases = [
  {
    name: "xcconfig without entitlements",
    xcconfig: "OTHER_LDFLAGS = $(inherited) -ObjC\n",
    manual: false,
  },
  {
    name: "Pods-named xcconfig with the app's entitlements",
    xcconfig: "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements\n",
    manual: true,
  },
  {
    name: "#include chain with the app's entitlements",
    xcconfig: '#include "Shared.xcconfig"\n',
    manual: true,
  },
];
for (const { name, xcconfig, manual } of cases) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-ownership-probe-")));
  try {
    await createIOSFixture(root, {
      platform: "macos",
      clerkSDK: false,
      includeKey: false,
      secondTarget: true,
    });
    const dir = join(root, "Pods/Target Support Files/Pods-AdminApp");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Pods-AdminApp.debug.xcconfig"), xcconfig);
    await writeFile(
      join(dir, "Shared.xcconfig"),
      "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements\n",
    );
    const path = join(root, "MyApp.xcodeproj/project.pbxproj");
    const document = parse(await readFile(path, "utf8"));
    const objects = document.objects as Record<string, any>;
    objects.PODSXCCONFIG000000000000 = {
      isa: "PBXFileReference",
      lastKnownFileType: "text.xcconfig",
      path: "Pods/Target Support Files/Pods-AdminApp/Pods-AdminApp.debug.xcconfig",
      sourceTree: "<group>",
    };
    objects[ids.mainGroup].children.push("PODSXCCONFIG000000000000");
    for (const id of [ids.secondDebug, ids.secondRelease])
      objects[id].baseConfigurationReference = "PODSXCCONFIG000000000000";
    await writeFile(path, build(document));
    const preview = await prepareSetup({
      root,
      target: "MyApp",
      products: "core",
      minimumVersion: "1.0.0",
      resolvePackages: false,
      capabilities: true,
    });
    if ((preview.capabilities?.status === "manual") !== manual)
      throw new Error(`${name}: expected ${manual ? "manual" : "automatic"} entitlements.`);
    console.log(JSON.stringify({ case: name, capabilities: preview.capabilities?.status }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
