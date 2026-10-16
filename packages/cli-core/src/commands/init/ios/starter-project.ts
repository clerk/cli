import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFile } from "./files.ts";
import { STARTER_VIEW, starterApp } from "./starter.ts";

export type ApplePlatform = "ios" | "macos";

export interface StarterProject {
  /** Xcode target and product name; a Swift identifier, so setup recognizes the starter. */
  name: string;
  bundleIdentifier: string;
  /** Apple Developer Team ID, written to every configuration so setup resolves the App ID Prefix. */
  teamId: string;
  platform: ApplePlatform;
}

export const SWIFT_TARGET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const BUNDLE_IDENTIFIER = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export const TEAM_ID = /^[A-Z0-9]{10}$/;

// The deployment floors native setup accepts (plan.ts), so the starter runs on every supported OS.
const IPHONEOS_DEPLOYMENT_TARGET = "17.0";
const MACOSX_DEPLOYMENT_TARGET = "14.0";

// Object IDs only need to be unique within the project file.
const ID = {
  project: "C1E4C0DE0000000000000001",
  mainGroup: "C1E4C0DE0000000000000002",
  productsGroup: "C1E4C0DE0000000000000003",
  sourceGroup: "C1E4C0DE0000000000000004",
  product: "C1E4C0DE0000000000000005",
  target: "C1E4C0DE0000000000000006",
  sources: "C1E4C0DE0000000000000007",
  frameworks: "C1E4C0DE0000000000000008",
  resources: "C1E4C0DE0000000000000009",
  projectConfigurations: "C1E4C0DE000000000000000A",
  targetConfigurations: "C1E4C0DE000000000000000B",
  projectDebug: "C1E4C0DE000000000000000C",
  projectRelease: "C1E4C0DE000000000000000D",
  targetDebug: "C1E4C0DE000000000000000E",
  targetRelease: "C1E4C0DE000000000000000F",
} as const;

type Settings = Record<string, string | string[]>;

function quote(value: string): string {
  return /^[A-Za-z0-9_./]+$/.test(value) ? value : JSON.stringify(value);
}

function settingsBlock(settings: Settings): string {
  return Object.keys(settings)
    .sort()
    .map((key) => {
      const value = settings[key]!;
      return Array.isArray(value)
        ? `\t\t\t\t${key} = (\n${value.map((item) => `\t\t\t\t\t${quote(item)},\n`).join("")}\t\t\t\t);\n`
        : `\t\t\t\t${key} = ${quote(value)};\n`;
    })
    .join("");
}

const PROJECT_SETTINGS: Settings = {
  ALWAYS_SEARCH_USER_PATHS: "NO",
  ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS: "YES",
  CLANG_ANALYZER_NONNULL: "YES",
  CLANG_ANALYZER_NUMBER_OBJECT_CONVERSION: "YES_AGGRESSIVE",
  CLANG_CXX_LANGUAGE_STANDARD: "gnu++20",
  CLANG_ENABLE_MODULES: "YES",
  CLANG_ENABLE_OBJC_ARC: "YES",
  CLANG_ENABLE_OBJC_WEAK: "YES",
  CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING: "YES",
  CLANG_WARN_BOOL_CONVERSION: "YES",
  CLANG_WARN_COMMA: "YES",
  CLANG_WARN_CONSTANT_CONVERSION: "YES",
  CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS: "YES",
  CLANG_WARN_DIRECT_OBJC_ISA_USAGE: "YES_ERROR",
  CLANG_WARN_DOCUMENTATION_COMMENTS: "YES",
  CLANG_WARN_EMPTY_BODY: "YES",
  CLANG_WARN_ENUM_CONVERSION: "YES",
  CLANG_WARN_INFINITE_RECURSION: "YES",
  CLANG_WARN_INT_CONVERSION: "YES",
  CLANG_WARN_NON_LITERAL_NULL_CONVERSION: "YES",
  CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF: "YES",
  CLANG_WARN_OBJC_LITERAL_CONVERSION: "YES",
  CLANG_WARN_OBJC_ROOT_CLASS: "YES_ERROR",
  CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER: "YES",
  CLANG_WARN_RANGE_LOOP_ANALYSIS: "YES",
  CLANG_WARN_STRICT_PROTOTYPES: "YES",
  CLANG_WARN_SUSPICIOUS_MOVE: "YES",
  CLANG_WARN_UNGUARDED_AVAILABILITY: "YES_AGGRESSIVE",
  CLANG_WARN_UNREACHABLE_CODE: "YES",
  CLANG_WARN__DUPLICATE_METHOD_MATCH: "YES",
  COPY_PHASE_STRIP: "NO",
  ENABLE_STRICT_OBJC_MSGSEND: "YES",
  ENABLE_USER_SCRIPT_SANDBOXING: "YES",
  GCC_C_LANGUAGE_STANDARD: "gnu17",
  GCC_NO_COMMON_BLOCKS: "YES",
  GCC_WARN_64_TO_32_BIT_CONVERSION: "YES",
  GCC_WARN_ABOUT_RETURN_TYPE: "YES_ERROR",
  GCC_WARN_UNDECLARED_SELECTOR: "YES",
  GCC_WARN_UNINITIALIZED_AUTOS: "YES_AGGRESSIVE",
  GCC_WARN_UNUSED_FUNCTION: "YES",
  GCC_WARN_UNUSED_VARIABLE: "YES",
  LOCALIZATION_PREFERS_STRING_CATALOGS: "YES",
  MTL_FAST_MATH: "YES",
};

const PROJECT_DEBUG: Settings = {
  DEBUG_INFORMATION_FORMAT: "dwarf",
  ENABLE_TESTABILITY: "YES",
  GCC_DYNAMIC_NO_PIC: "NO",
  GCC_OPTIMIZATION_LEVEL: "0",
  GCC_PREPROCESSOR_DEFINITIONS: ["DEBUG=1", "$(inherited)"],
  MTL_ENABLE_DEBUG_INFO: "INCLUDE_SOURCE",
  // Without it, Debug builds every architecture and Swift packages fail to resolve their modules.
  ONLY_ACTIVE_ARCH: "YES",
  SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG $(inherited)",
  SWIFT_OPTIMIZATION_LEVEL: "-Onone",
};

const PROJECT_RELEASE: Settings = {
  DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
  ENABLE_NS_ASSERTIONS: "NO",
  MTL_ENABLE_DEBUG_INFO: "NO",
  SWIFT_COMPILATION_MODE: "wholemodule",
};

function platformProjectSettings(platform: ApplePlatform, release: boolean): Settings {
  return platform === "ios"
    ? {
        IPHONEOS_DEPLOYMENT_TARGET,
        SDKROOT: "iphoneos",
        ...(release ? { VALIDATE_PRODUCT: "YES" } : {}),
      }
    : { MACOSX_DEPLOYMENT_TARGET, SDKROOT: "macosx" };
}

function targetSettings({ bundleIdentifier, teamId, platform }: StarterProject): Settings {
  const shared: Settings = {
    ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
    ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: "AccentColor",
    CODE_SIGN_STYLE: "Automatic",
    CURRENT_PROJECT_VERSION: "1",
    DEVELOPMENT_TEAM: teamId,
    ENABLE_PREVIEWS: "YES",
    GENERATE_INFOPLIST_FILE: "YES",
    MARKETING_VERSION: "1.0",
    PRODUCT_BUNDLE_IDENTIFIER: bundleIdentifier,
    PRODUCT_NAME: "$(TARGET_NAME)",
    STRING_CATALOG_GENERATE_SYMBOLS: "YES",
    SWIFT_APPROACHABLE_CONCURRENCY: "YES",
    SWIFT_DEFAULT_ACTOR_ISOLATION: "MainActor",
    SWIFT_EMIT_LOC_STRINGS: "YES",
    SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY: "YES",
    SWIFT_VERSION: "5.0",
  };
  return platform === "ios"
    ? {
        ...shared,
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: "YES",
        INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents: "YES",
        // Without a launch screen, iOS runs the app letterboxed in legacy display mode.
        INFOPLIST_KEY_UILaunchScreen_Generation: "YES",
        INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad:
          "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
        INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone:
          "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
        LD_RUNPATH_SEARCH_PATHS: ["$(inherited)", "@executable_path/Frameworks"],
        TARGETED_DEVICE_FAMILY: "1,2",
      }
    : {
        ...shared,
        COMBINE_HIDPI_IMAGES: "YES",
        ENABLE_APP_SANDBOX: "YES",
        ENABLE_HARDENED_RUNTIME: "YES",
        ENABLE_USER_SELECTED_FILES: "readonly",
        INFOPLIST_KEY_NSHumanReadableCopyright: "",
        LD_RUNPATH_SEARCH_PATHS: ["$(inherited)", "@executable_path/../Frameworks"],
        REGISTER_APP_GROUPS: "YES",
      };
}

function configuration(id: string, name: string, settings: Settings): string {
  return `\t\t${id} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n${settingsBlock(settings)}\t\t\t};\n\t\t\tname = ${name};\n\t\t};\n`;
}

/** The project file Xcode's SwiftUI App template creates, with a folder-synchronized source group. */
export function starterProjectFile(project: StarterProject): string {
  const { name, platform } = project;
  const target = targetSettings(project);
  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {
\t};
\tobjectVersion = 77;
\tobjects = {

/* Begin PBXFileReference section */
\t\t${ID.product} /* ${name}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${quote(`${name}.app`)}; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFileSystemSynchronizedRootGroup section */
\t\t${ID.sourceGroup} /* ${name} */ = {
\t\t\tisa = PBXFileSystemSynchronizedRootGroup;
\t\t\tpath = ${quote(name)};
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${ID.frameworks} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${ID.mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${ID.sourceGroup} /* ${name} */,
\t\t\t\t${ID.productsGroup} /* Products */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${ID.productsGroup} /* Products */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${ID.product} /* ${name}.app */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${ID.target} /* ${name} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${ID.targetConfigurations} /* Build configuration list for PBXNativeTarget "${name}" */;
\t\t\tbuildPhases = (
\t\t\t\t${ID.sources} /* Sources */,
\t\t\t\t${ID.frameworks} /* Frameworks */,
\t\t\t\t${ID.resources} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tfileSystemSynchronizedGroups = (
\t\t\t\t${ID.sourceGroup} /* ${name} */,
\t\t\t);
\t\t\tname = ${quote(name)};
\t\t\tpackageProductDependencies = (
\t\t\t);
\t\t\tproductName = ${quote(name)};
\t\t\tproductReference = ${ID.product} /* ${name}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${ID.project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 2600;
\t\t\t\tLastUpgradeCheck = 2600;
\t\t\t\tTargetAttributes = {
\t\t\t\t\t${ID.target} = {
\t\t\t\t\t\tCreatedOnToolsVersion = 26.0;
\t\t\t\t\t};
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = ${ID.projectConfigurations} /* Build configuration list for PBXProject "${name}" */;
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${ID.mainGroup};
\t\t\tminimizedProjectReferenceProxies = 1;
\t\t\tpreferredProjectObjectVersion = 77;
\t\t\tproductRefGroup = ${ID.productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${ID.target} /* ${name} */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${ID.resources} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${ID.sources} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
${configuration(ID.projectDebug, "Debug", { ...PROJECT_SETTINGS, ...PROJECT_DEBUG, ...platformProjectSettings(platform, false) })}${configuration(ID.projectRelease, "Release", { ...PROJECT_SETTINGS, ...PROJECT_RELEASE, ...platformProjectSettings(platform, true) })}${configuration(ID.targetDebug, "Debug", target)}${configuration(ID.targetRelease, "Release", target)}/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${ID.projectConfigurations} /* Build configuration list for PBXProject "${name}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${ID.projectDebug} /* Debug */,
\t\t\t\t${ID.projectRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${ID.targetConfigurations} /* Build configuration list for PBXNativeTarget "${name}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${ID.targetDebug} /* Debug */,
\t\t\t\t${ID.targetRelease} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${ID.project} /* Project object */;
}
`;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ASSET_INFO = { author: "xcode", version: 1 };

function appIcon(platform: ApplePlatform) {
  if (platform === "ios")
    return {
      images: [
        { idiom: "universal", platform: "ios", size: "1024x1024" },
        {
          appearances: [{ appearance: "luminosity", value: "dark" }],
          idiom: "universal",
          platform: "ios",
          size: "1024x1024",
        },
        {
          appearances: [{ appearance: "luminosity", value: "tinted" }],
          idiom: "universal",
          platform: "ios",
          size: "1024x1024",
        },
      ],
      info: ASSET_INFO,
    };
  return {
    images: ["16x16", "32x32", "128x128", "256x256", "512x512"].flatMap((size) =>
      ["1x", "2x"].map((scale) => ({ idiom: "mac", scale, size })),
    ),
    info: ASSET_INFO,
  };
}

/** Every file of a new starter, keyed by path relative to the project directory. */
export function starterProjectFiles(project: StarterProject): Record<string, string> {
  const { name, platform } = project;
  const header = (file: string) => `//\n//  ${file}\n//  ${name}\n//\n\n`;
  return {
    [`${name}.xcodeproj/project.pbxproj`]: starterProjectFile(project),
    [`${name}/${name}App.swift`]: header(`${name}App.swift`) + starterApp(name),
    [`${name}/ContentView.swift`]: header("ContentView.swift") + STARTER_VIEW,
    [`${name}/Assets.xcassets/Contents.json`]: json({ info: ASSET_INFO }),
    [`${name}/Assets.xcassets/AccentColor.colorset/Contents.json`]: json({
      colors: [{ idiom: "universal" }],
      info: ASSET_INFO,
    }),
    [`${name}/Assets.xcassets/AppIcon.appiconset/Contents.json`]: json(appIcon(platform)),
  };
}

/**
 * Writes a new starter into `directory`, which must not exist yet. A failure removes the
 * partly written directory, so a retry starts clean.
 */
export async function writeStarterProject(
  directory: string,
  project: StarterProject,
): Promise<void> {
  await mkdir(directory);
  try {
    for (const [path, content] of Object.entries(starterProjectFiles(project))) {
      await mkdir(join(directory, dirname(path)), { recursive: true });
      await createFile(directory, path, content);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
