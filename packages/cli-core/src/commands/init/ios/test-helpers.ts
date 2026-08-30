import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { build as buildPbxProject, parse as parsePbxProject } from "@bacons/xcode/json";
import type { PbxObjects } from "./pbx.ts";

const IDS = {
  project: "AAAAAAAAAAAAAAAAAAAAAAAA",
  mainGroup: "BBBBBBBBBBBBBBBBBBBBBBBB",
  appGroup: "CCCCCCCCCCCCCCCCCCCCCCCC",
  appFile: "DDDDDDDDDDDDDDDDDDDDDDDD",
  entitlementsFile: "EEEEEEEEEEEEEEEEEEEEEEEE",
  appTarget: "111111111111111111111111",
  appProduct: "121212121212121212121212",
  projectConfigList: "131313131313131313131313",
  projectDebug: "141414141414141414141414",
  projectRelease: "151515151515151515151515",
  targetConfigList: "161616161616161616161616",
  targetDebug: "171717171717171717171717",
  targetRelease: "181818181818181818181818",
  sourcesPhase: "191919191919191919191919",
  sourceBuildFile: "202020202020202020202020",
  frameworksPhase: "212121212121212121212121",
  clerkPackage: "222222222222222222222222",
  clerkKit: "232323232323232323232323",
  clerkKitUI: "242424242424242424242424",
  clerkKitBuildFile: "252525252525252525252525",
  clerkKitUIBuildFile: "262626262626262626262626",
  secondTarget: "313131313131313131313131",
  secondProduct: "323232323232323232323232",
  secondConfigList: "333333333333333333333333",
  secondDebug: "343434343434343434343434",
  secondRelease: "353535353535353535353535",
  targetXCConfig: "363636363636363636363636",
  localSecretsFile: "373737373737373737373737",
  resourcesPhase: "383838383838383838383838",
  localSecretsBuildFile: "393939393939393939393939",
  secondGroup: "404040404040404040404040",
  secondAppFile: "414141414141414141414141",
  secondSourcesPhase: "424242424242424242424242",
  secondSourceBuildFile: "434343434343434343434343",
  secondFrameworksPhase: "444444444444444444444444",
} as const;

export interface IOSFixtureOptions {
  complete?: boolean;
  platform?: "ios" | "macos";
  /** Override one configuration to exercise cross-configuration platform certainty. */
  releasePlatform?: "ios" | "macos" | "unresolved";
  secondTarget?: boolean | "watchos";
  conflictingBundle?: boolean;
  includeKey?: boolean;
  releaseEntitlements?: boolean;
  workspace?: boolean;
  generated?: "xcodegen" | "tuist";
  xcconfig?: boolean;
  localSecrets?: boolean;
  /** Include the canonical native Apple entitlement in the macOS fixture. */
  macOSAppleEntitlement?: boolean;
  /** Include a fully linked clerk-ios package graph. Defaults to both products. */
  clerkSDK?: boolean | "core-only";
}

function secondTargetObjects(platform: "ios" | "watchos"): string {
  const isWatchOS = platform === "watchos";
  const directoryName = isWatchOS ? "WatchApp" : "AdminApp";
  const sourceName = isWatchOS ? "WatchAppApp.swift" : "AdminAppApp.swift";
  const targetName = isWatchOS ? "MyApp Watch App" : "AdminApp";
  const platformSettings = isWatchOS
    ? 'PRODUCT_BUNDLE_IDENTIFIER = com.example.WatchApp; DEVELOPMENT_TEAM = ABCDE12345; SDKROOT = watchos; SUPPORTED_PLATFORMS = "watchos watchsimulator"; WATCHOS_DEPLOYMENT_TARGET = 10.0; IPHONEOS_DEPLOYMENT_TARGET = 17.0;'
    : 'PRODUCT_BUNDLE_IDENTIFIER = com.example.AdminApp; DEVELOPMENT_TEAM = ABCDE12345; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";';
  return `
    ${IDS.secondGroup} = { isa = PBXGroup; children = ( ${IDS.secondAppFile}, ); path = ${directoryName}; sourceTree = "<group>"; };
    ${IDS.secondAppFile} = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${sourceName}; sourceTree = "<group>"; };
    ${IDS.secondTarget} = {
      isa = PBXNativeTarget;
      buildConfigurationList = ${IDS.secondConfigList};
      buildPhases = ( ${IDS.secondSourcesPhase}, ${IDS.secondFrameworksPhase}, );
      buildRules = ( );
      dependencies = ( );
      name = "${targetName}";
      productName = "${targetName}";
      productReference = ${IDS.secondProduct};
      productType = "com.apple.product-type.application";
      packageProductDependencies = ( );
    };
    ${IDS.secondProduct} = { isa = PBXFileReference; explicitFileType = wrapper.application; path = ${directoryName}.app; sourceTree = BUILT_PRODUCTS_DIR; };
    ${IDS.secondSourcesPhase} = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ( ${IDS.secondSourceBuildFile}, ); runOnlyForDeploymentPostprocessing = 0; };
    ${IDS.secondSourceBuildFile} = { isa = PBXBuildFile; fileRef = ${IDS.secondAppFile}; };
    ${IDS.secondFrameworksPhase} = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ( ); runOnlyForDeploymentPostprocessing = 0; };
    ${IDS.secondConfigList} = { isa = XCConfigurationList; buildConfigurations = ( ${IDS.secondDebug}, ${IDS.secondRelease}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    ${IDS.secondDebug} = { isa = XCBuildConfiguration; buildSettings = { ${platformSettings} }; name = Debug; };
    ${IDS.secondRelease} = { isa = XCBuildConfiguration; buildSettings = { ${platformSettings} }; name = Release; };
  `;
}

function pbxproj(options: IOSFixtureOptions): string {
  const platform = options.platform ?? "ios";
  const sdkRoot = platform === "macos" ? "macosx" : "iphoneos";
  const supportedPlatforms = platform === "macos" ? "macosx" : "iphoneos iphonesimulator";
  const releasePlatform = options.releasePlatform ?? platform;
  const releaseSDKRoot =
    releasePlatform === "unresolved"
      ? '"$(UNKNOWN_SDKROOT)"'
      : releasePlatform === "macos"
        ? "macosx"
        : "iphoneos";
  const releaseSupportedPlatforms =
    releasePlatform === "unresolved"
      ? "$(UNKNOWN_PLATFORMS)"
      : releasePlatform === "macos"
        ? "macosx"
        : "iphoneos iphonesimulator";
  const deploymentTargetSetting =
    platform === "macos"
      ? "MACOSX_DEPLOYMENT_TARGET = 14.0;"
      : "IPHONEOS_DEPLOYMENT_TARGET = 17.0;";
  const sandboxSettings = platform === "macos" ? "ENABLE_APP_SANDBOX = YES;" : "";
  const includeClerkSDK = options.clerkSDK !== false;
  const includeClerkKitUI = includeClerkSDK && options.clerkSDK !== "core-only";
  const releaseBundle = options.conflictingBundle
    ? "com.example.MyApp.release"
    : "com.example.MyApp";
  const releaseEntitlements =
    options.releaseEntitlements === false
      ? ""
      : "CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements;";
  const debugIdentitySettings = options.xcconfig
    ? ""
    : "DEVELOPMENT_TEAM = ABCDE12345; PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;";
  const releaseIdentitySettings = options.xcconfig
    ? ""
    : `DEVELOPMENT_TEAM = ABCDE12345; PRODUCT_BUNDLE_IDENTIFIER = ${releaseBundle};`;
  const baseConfigurationReference = options.xcconfig
    ? `baseConfigurationReference = ${IDS.targetXCConfig};`
    : "";
  const targetIds = options.secondTarget
    ? `${IDS.appTarget}, ${IDS.secondTarget},`
    : `${IDS.appTarget},`;
  return `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = { };
  objectVersion = 56;
  objects = {
    ${IDS.project} = {
      isa = PBXProject;
      attributes = { LastUpgradeCheck = 1600; };
      buildConfigurationList = ${IDS.projectConfigList};
      compatibilityVersion = "Xcode 14.0";
      developmentRegion = en;
      knownRegions = ( en, Base, );
      mainGroup = ${IDS.mainGroup};
      packageReferences = ( ${includeClerkSDK ? `${IDS.clerkPackage},` : ""} );
      projectDirPath = "";
      projectRoot = "";
      targets = ( ${targetIds} );
    };
    ${IDS.mainGroup} = { isa = PBXGroup; children = ( ${IDS.appGroup}, ${options.secondTarget ? `${IDS.secondGroup},` : ""} ${IDS.entitlementsFile}, ${options.xcconfig ? `${IDS.targetXCConfig},` : ""} ); sourceTree = "<group>"; };
    ${IDS.appGroup} = { isa = PBXGroup; children = ( ${IDS.appFile}, ${options.localSecrets ? `${IDS.localSecretsFile},` : ""} ); path = MyApp; sourceTree = "<group>"; };
    ${IDS.appFile} = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MyAppApp.swift; sourceTree = "<group>"; };
    ${options.localSecrets ? `${IDS.localSecretsFile} = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = LocalSecrets.plist; sourceTree = "<group>"; };` : ""}
    ${IDS.entitlementsFile} = { isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = MyApp/MyApp.entitlements; sourceTree = "<group>"; };
    ${options.xcconfig ? `${IDS.targetXCConfig} = { isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Config/Target.xcconfig; sourceTree = "<group>"; };` : ""}
    ${IDS.appTarget} = {
      isa = PBXNativeTarget;
      buildConfigurationList = ${IDS.targetConfigList};
      buildPhases = ( ${IDS.sourcesPhase}, ${IDS.frameworksPhase}, ${options.localSecrets ? `${IDS.resourcesPhase},` : ""} );
      buildRules = ( );
      dependencies = ( );
      name = MyApp;
      productName = MyApp;
      productReference = ${IDS.appProduct};
      productType = "com.apple.product-type.application";
      packageProductDependencies = ( ${includeClerkSDK ? `${IDS.clerkKit},` : ""} ${includeClerkKitUI ? `${IDS.clerkKitUI},` : ""} );
    };
    ${IDS.appProduct} = { isa = PBXFileReference; explicitFileType = wrapper.application; path = MyApp.app; sourceTree = BUILT_PRODUCTS_DIR; };
    ${IDS.sourcesPhase} = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ( ${IDS.sourceBuildFile}, ); runOnlyForDeploymentPostprocessing = 0; };
    ${IDS.sourceBuildFile} = { isa = PBXBuildFile; fileRef = ${IDS.appFile}; };
    ${options.localSecrets ? `${IDS.resourcesPhase} = { isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ( ${IDS.localSecretsBuildFile}, ); runOnlyForDeploymentPostprocessing = 0; }; ${IDS.localSecretsBuildFile} = { isa = PBXBuildFile; fileRef = ${IDS.localSecretsFile}; };` : ""}
    ${IDS.frameworksPhase} = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ( ${includeClerkSDK ? `${IDS.clerkKitBuildFile},` : ""} ${includeClerkKitUI ? `${IDS.clerkKitUIBuildFile},` : ""} ); runOnlyForDeploymentPostprocessing = 0; };
    ${includeClerkSDK ? `${IDS.clerkKitBuildFile} = { isa = PBXBuildFile; productRef = ${IDS.clerkKit}; };` : ""}
    ${includeClerkKitUI ? `${IDS.clerkKitUIBuildFile} = { isa = PBXBuildFile; productRef = ${IDS.clerkKitUI}; };` : ""}
    ${includeClerkSDK ? `${IDS.clerkPackage} = { isa = XCRemoteSwiftPackageReference; repositoryURL = "https://github.com/clerk/clerk-ios.git"; requirement = { kind = upToNextMajorVersion; minimumVersion = 1.0.0; }; };` : ""}
    ${includeClerkSDK ? `${IDS.clerkKit} = { isa = XCSwiftPackageProductDependency; package = ${IDS.clerkPackage}; productName = ClerkKit; };` : ""}
    ${includeClerkKitUI ? `${IDS.clerkKitUI} = { isa = XCSwiftPackageProductDependency; package = ${IDS.clerkPackage}; productName = ClerkKitUI; };` : ""}
    ${IDS.projectConfigList} = { isa = XCConfigurationList; buildConfigurations = ( ${IDS.projectDebug}, ${IDS.projectRelease}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    ${IDS.projectDebug} = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = ${sdkRoot}; }; name = Debug; };
    ${IDS.projectRelease} = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = ${releaseSDKRoot}; }; name = Release; };
    ${IDS.targetConfigList} = { isa = XCConfigurationList; buildConfigurations = ( ${IDS.targetDebug}, ${IDS.targetRelease}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    ${IDS.targetDebug} = { isa = XCBuildConfiguration; ${baseConfigurationReference} buildSettings = { CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements; ${debugIdentitySettings} ${deploymentTargetSetting} ${sandboxSettings} SUPPORTED_PLATFORMS = "${supportedPlatforms}"; }; name = Debug; };
    ${IDS.targetRelease} = { isa = XCBuildConfiguration; ${baseConfigurationReference} buildSettings = { ${releaseEntitlements} ${releaseIdentitySettings} ${deploymentTargetSetting} ${sandboxSettings} SUPPORTED_PLATFORMS = "${releaseSupportedPlatforms}"; }; name = Release; };
    ${options.secondTarget ? secondTargetObjects(options.secondTarget === "watchos" ? "watchos" : "ios") : ""}
  };
  rootObject = ${IDS.project};
}
`;
}

function swiftSource(complete: boolean): string {
  if (!complete) {
    return `import SwiftUI

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`;
  }
  return `import ClerkKit
import ClerkKitUI
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: QuickstartLocalSecrets.load().publishableKey ?? "") }
  var body: some Scene {
    WindowGroup {
      AuthView()
        .environment(Clerk.shared)
        .onOpenURL { url in Task { try await Clerk.shared.handle(url) } }
    }
  }
}

struct QuickstartLocalSecrets {
  let publishableKey: String?

  static func load(bundle: Bundle = .main) -> QuickstartLocalSecrets {
    let values: [String: Any]
    if let url = bundle.url(forResource: "LocalSecrets", withExtension: "plist"),
       let data = try? Data(contentsOf: url),
       let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
       let dictionary = plist as? [String: Any] {
      values = dictionary
    } else {
      values = [:]
    }
    return .init(publishableKey: values["CLERK_PUBLISHABLE_KEY"] as? String)
  }
}
`;
}

function secondSwiftSource(platform: "ios" | "watchos"): string {
  const appName = platform === "watchos" ? "WatchAppApp" : "AdminAppApp";
  return `import SwiftUI

@main
struct ${appName}: App {
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`;
}

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>LEGACY1234.com.example.MyApp</string>
<key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
<key>com.apple.developer.associated-domains</key><array><string>webcredentials:clerk.example.test</string></array>
</dict></plist>
`;

function macOSEntitlements(includeApple: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
${includeApple ? "<key>com.apple.developer.applesignin</key><array><string>Default</string></array>" : ""}
</dict></plist>
`;
}

export async function createIOSFixture(
  root: string,
  options: IOSFixtureOptions = {},
): Promise<void> {
  const project = join(root, "MyApp.xcodeproj");
  await mkdir(join(project), { recursive: true });
  await mkdir(join(root, "MyApp"), { recursive: true });
  await Bun.write(join(project, "project.pbxproj"), pbxproj(options));
  await Bun.write(join(root, "MyApp", "MyAppApp.swift"), swiftSource(options.complete === true));
  await Bun.write(
    join(root, "MyApp", "MyApp.entitlements"),
    options.platform === "macos"
      ? macOSEntitlements(options.macOSAppleEntitlement !== false)
      : ENTITLEMENTS,
  );
  if (options.secondTarget) {
    const platform = options.secondTarget === "watchos" ? "watchos" : "ios";
    const directoryName = platform === "watchos" ? "WatchApp" : "AdminApp";
    const sourceName = platform === "watchos" ? "WatchAppApp.swift" : "AdminAppApp.swift";
    await mkdir(join(root, directoryName), { recursive: true });
    await Bun.write(join(root, directoryName, sourceName), secondSwiftSource(platform));
  }
  if (options.localSecrets) {
    const encodedHost = Buffer.from("native.clerk.example$").toString("base64");
    await Bun.write(
      join(root, "MyApp", "LocalSecrets.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CLERK_PUBLISHABLE_KEY</key><string>pk_live_${encodedHost}</string></dict></plist>`,
    );
  }

  if (options.xcconfig) {
    await mkdir(join(root, "Config"), { recursive: true });
    await Bun.write(
      join(root, "Config", "Base.xcconfig"),
      "BUNDLE_BASE = com.example\nDEVELOPMENT_TEAM = ABCDE12345\n",
    );
    await Bun.write(
      join(root, "Config", "Target.xcconfig"),
      '#include "Base.xcconfig"\nPRODUCT_BUNDLE_IDENTIFIER = $(BUNDLE_BASE).MyApp\n',
    );
  }

  if (options.includeKey !== false) {
    const encodedHost = Buffer.from("clerk.example.test$").toString("base64");
    await Bun.write(join(root, ".env"), `CLERK_PUBLISHABLE_KEY=pk_test_${encodedHost}\n`);
  }
  if (options.workspace) {
    const workspace = join(root, "MyApp.xcworkspace");
    await mkdir(workspace, { recursive: true });
    await Bun.write(
      join(workspace, "contents.xcworkspacedata"),
      '<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:MyApp.xcodeproj"></FileRef></Workspace>',
    );
  }
  if (options.generated === "xcodegen") await Bun.write(join(root, "project.yml"), "name: MyApp\n");
  if (options.generated === "tuist")
    await Bun.write(join(root, "Project.swift"), "import ProjectDescription\n");
}

/** Converts the classic fixture into the modern synchronized-root shape used by new Xcode apps. */
export async function convertIOSFixtureToSynchronizedRoot(root: string): Promise<void> {
  const synchronizedRootId = "515151515151515151515151";
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  const mainGroup = objects[IDS.mainGroup]!;
  mainGroup.children = [
    ...(mainGroup.children as string[]).filter((id) => id !== IDS.entitlementsFile),
    synchronizedRootId,
  ];
  objects[synchronizedRootId] = {
    isa: "PBXFileSystemSynchronizedRootGroup",
    path: "MyApp",
    sourceTree: "<group>",
  };
  objects[IDS.appTarget]!.fileSystemSynchronizedGroups = [synchronizedRootId];
  delete objects[IDS.entitlementsFile];
  await writeFile(projectPath, buildPbxProject(project));
}

export async function convertIOSFixtureToSynchronizedMissingEntitlements(
  root: string,
): Promise<void> {
  await convertIOSFixtureToSynchronizedRoot(root);
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    const settings = objects[id]!.buildSettings as Record<string, unknown>;
    delete settings.CODE_SIGN_ENTITLEMENTS;
    settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"] = "MyApp/MyApp.mac.entitlements";
  }
  await writeFile(projectPath, buildPbxProject(project));
  await rm(join(root, "MyApp", "MyApp.entitlements"), { force: true });
}

/** Converts the selected fixture target into Xcode's common single-target iOS + macOS shape. */
export async function convertIOSFixtureToMultiplatform(root: string): Promise<void> {
  const projectPath = join(root, "MyApp.xcodeproj", "project.pbxproj");
  const project = parsePbxProject(await readFile(projectPath, "utf8"));
  const objects = (project as unknown as { objects: PbxObjects }).objects;
  const macOSEntitlementsExists = await Bun.file(
    join(root, "MyApp", "MyApp.mac.entitlements"),
  ).exists();

  for (const id of [IDS.projectDebug, IDS.projectRelease]) {
    const settings = objects[id]!.buildSettings as Record<string, unknown>;
    settings.SDKROOT = "auto";
  }

  for (const id of [IDS.targetDebug, IDS.targetRelease]) {
    const settings = objects[id]!.buildSettings as Record<string, unknown>;
    const existingEntitlements = settings.CODE_SIGN_ENTITLEMENTS;
    delete settings.CODE_SIGN_ENTITLEMENTS;
    settings.SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx";
    settings.IPHONEOS_DEPLOYMENT_TARGET = "17.0";
    settings.MACOSX_DEPLOYMENT_TARGET = "14.0";
    settings.ENABLE_APP_SANDBOX = "YES";
    if (typeof existingEntitlements === "string" && existingEntitlements.length > 0) {
      settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"] = existingEntitlements;
      settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"] = existingEntitlements;
      settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"] = "MyApp/MyApp.mac.entitlements";
    }
    if (!macOSEntitlementsExists) delete settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"];
  }

  await writeFile(projectPath, buildPbxProject(project));
}

async function digestEntry(root: string, path: string): Promise<string[]> {
  const info = await lstat(path);
  const relativePath = relative(root, path).split("\\").join("/") || ".";
  if (info.isSymbolicLink()) {
    return [`l:${relativePath}:${info.mode}:${await readlink(path)}`];
  }
  if (info.isDirectory()) {
    const entries = (await readdir(path)).sort();
    const nested = await Promise.all(
      entries.map(async (entry) => digestEntry(root, join(path, entry))),
    );
    return [`d:${relativePath}:${info.mode}`, ...nested.flat()];
  }
  const hash = new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");
  return [`f:${relativePath}:${info.mode}:${hash}`];
}

export async function treeDigest(root: string): Promise<string[]> {
  return digestEntry(root, root);
}

export { IDS as IOS_FIXTURE_IDS };
