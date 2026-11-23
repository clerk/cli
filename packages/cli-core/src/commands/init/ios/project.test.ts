import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capabilitySettings } from "./project.ts";
import { applyXCProjValue } from "./xcproj.ts";
import type { Selection } from "./plan.ts";

const selection = (targetId: string): Selection => ({
  root: "/project",
  project: "MyApp.xcodeproj",
  targetId,
  targetName: "MyApp",
  configuration: "Debug",
  sdk: "iphoneos",
});

const pbxproj = `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = { };
  objectVersion = 77;
  objects = {
    AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; buildConfigurationList = 131313131313131313131313; mainGroup = BBBBBBBBBBBBBBBBBBBBBBBB; targets = ( 111111111111111111111111, 222222222222222222222222, ); };
    BBBBBBBBBBBBBBBBBBBBBBBB = { isa = PBXGroup; children = ( CCCCCCCCCCCCCCCCCCCCCCCC, DDDDDDDDDDDDDDDDDDDDDDDD, EEEEEEEEEEEEEEEEEEEEEEEE, FFFFFFFFFFFFFFFFFFFFFFFF, ); sourceTree = "<group>"; };
    CCCCCCCCCCCCCCCCCCCCCCCC = { isa = PBXGroup; children = ( C1C1C1C1C1C1C1C1C1C1C1C1, ); path = Sources; sourceTree = "<group>"; };
    C1C1C1C1C1C1C1C1C1C1C1C1 = { isa = PBXFileSystemSynchronizedRootGroup; path = MyApp; sourceTree = "<group>"; };
    DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXFileSystemSynchronizedRootGroup; path = Shared/Code; sourceTree = SOURCE_ROOT; };
    EEEEEEEEEEEEEEEEEEEEEEEE = { isa = PBXFileSystemSynchronizedRootGroup; path = /Users/someone/Elsewhere; sourceTree = "<absolute>"; };
    FFFFFFFFFFFFFFFFFFFFFFFF = { isa = PBXFileSystemSynchronizedRootGroup; path = Admin; sourceTree = "<group>"; };
    111111111111111111111111 = { isa = PBXNativeTarget; buildConfigurationList = 161616161616161616161616; fileSystemSynchronizedGroups = ( C1C1C1C1C1C1C1C1C1C1C1C1, DDDDDDDDDDDDDDDDDDDDDDDD, EEEEEEEEEEEEEEEEEEEEEEEE, ); name = MyApp; };
    222222222222222222222222 = { isa = PBXNativeTarget; buildConfigurationList = 262626262626262626262626; fileSystemSynchronizedGroups = ( FFFFFFFFFFFFFFFFFFFFFFFF, ); name = Admin; };
    131313131313131313131313 = { isa = XCConfigurationList; buildConfigurations = ( 141414141414141414141414, ); };
    141414141414141414141414 = { isa = XCBuildConfiguration; buildSettings = { }; name = Debug; };
    161616161616161616161616 = { isa = XCConfigurationList; buildConfigurations = ( 171717171717171717171717, ); };
    171717171717171717171717 = { isa = XCBuildConfiguration; buildSettings = { }; name = Debug; };
    262626262626262626262626 = { isa = XCConfigurationList; buildConfigurations = ( 272727272727272727272727, ); };
    272727272727272727272727 = { isa = XCBuildConfiguration; buildSettings = { }; name = Debug; };
  };
  rootObject = AAAAAAAAAAAAAAAAAAAAAAAA;
}
`;

test("a .pbxproj target's synchronized folders are resolved from SRCROOT, in project order", () => {
  expect(
    capabilitySettings(pbxproj, "pbxproj", selection("111111111111111111111111"))
      .synchronizedFolders,
  ).toEqual(["Sources/MyApp", "Shared/Code"]);
});

test("a .xcproj target's member folders are resolved through their groups", async () => {
  let source = await readFile(
    join(
      import.meta.dir,
      "../../../../../../test/e2e/fixtures/ios-json/MyApp.xcodeproj/project.xcproj",
    ),
    "utf8",
  );
  source = applyXCProjValue(
    source,
    ["files"],
    [
      {
        kind: "group",
        path: "Sources",
        children: [
          { kind: "folder", path: "MyApp", "target-membership": ["MyApp"] },
          { kind: "folder", path: "Admin", "target-membership": ["Admin"] },
          { path: "Notes.txt", "target-membership": ["MyApp"] },
        ],
      },
      { kind: "folder", path: "/Users/someone/Elsewhere", "target-membership": ["MyApp"] },
      { kind: "folder", path: "Shared", "target-membership": ["Admin", "MyApp"] },
    ],
  );
  expect(
    capabilitySettings(source, "xcproj", selection("C1E000000000000000000001")).synchronizedFolders,
  ).toEqual(["Sources/MyApp", "Shared"]);
});
