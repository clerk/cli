import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ScaffoldPlan } from "../frameworks/types.ts";
import { scaffoldSDK, type SDKInput } from "./sdk.ts";
import { setupError } from "./types.ts";

export interface Selection {
  root: string;
  project: string;
  targetId: string;
  targetName: string;
  configuration: string;
  sdk: "iphoneos" | "iphonesimulator" | "macosx";
}

export function settingsCommand(selection: Selection): string[] {
  return [
    "xcodebuild",
    "-project",
    selection.project,
    // Every target's settings in one call, so ownership checks see what Xcode resolves.
    "-alltargets",
    "-configuration",
    selection.configuration,
    "-sdk",
    selection.sdk,
    "-showBuildSettings",
    "-json",
    "-disableAutomaticPackageResolution",
  ];
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function selectedSettings(selection: Selection, output: string): Record<string, string> {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw setupError("Xcode did not return a build-settings array.");
  // Xcode can list a target twice with identical settings; only differing rows are ambiguous.
  const matches = [
    ...new Map(
      rows
        .filter((row) => record(row) && row.target === selection.targetName)
        .map((row) => [JSON.stringify(row.buildSettings), row]),
    ).values(),
  ];
  if (matches.length !== 1 || !record(matches[0]?.buildSettings)) {
    throw setupError("Xcode must return exactly one settings result for the selected target.");
  }
  const settings = matches[0].buildSettings;
  if (
    settings.TARGET_NAME !== selection.targetName ||
    settings.CONFIGURATION !== selection.configuration ||
    settings.PLATFORM_NAME !== selection.sdk ||
    typeof settings.PROJECT_FILE_PATH !== "string" ||
    resolve(settings.PROJECT_FILE_PATH) !== resolve(selection.root, selection.project) ||
    settings.PRODUCT_TYPE !== "com.apple.product-type.application" ||
    settings.IS_MACCATALYST === "YES"
  ) {
    throw setupError("Xcode settings do not match the selected iOS or macOS application context.");
  }
  return Object.fromEntries(
    Object.entries(settings).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Resolved settings of every other target in the same `-alltargets` output. */
export function otherTargetSettings(
  selection: Selection,
  output: string,
): Record<string, string>[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) =>
    record(row) && row.target !== selection.targetName && record(row.buildSettings)
      ? [row.buildSettings as Record<string, string>]
      : [],
  );
}

function relativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
  );
}

export interface SetupInput {
  selection: Selection;
  settingsJSON: string;
  projectSource: string;
  managedBy: SDKInput["managedBy"];
  projectFormat: "pbxproj" | "xcproj";
  products: "core" | "ui";
  minimumVersion: string;
}

export const AUTH_UI_STATE = "@State private var authIsPresented = false";
export const AUTH_UI_BODY = `UserButton(signedOutContent: {
  Button("Sign in") {
    authIsPresented = true
  }
})
.prefetchClerkImages()
.sheet(isPresented: $authIsPresented) {
  AuthView()
}
`;

export function planAppleSetup(input: SetupInput): ScaffoldPlan {
  const { selection } = input;
  if (!relativePath(selection.project) || !selection.project.endsWith(".xcodeproj")) {
    throw setupError("Select a root-relative project path without parent traversal.");
  }
  const settings = selectedSettings(selection, input.settingsJSON);
  const platform = selection.sdk === "macosx" ? "macOS" : "iOS";
  const deployment =
    settings[platform === "macOS" ? "MACOSX_DEPLOYMENT_TARGET" : "IPHONEOS_DEPLOYMENT_TARGET"];
  const minimum = platform === "macOS" ? 14 : 17;
  if (
    !deployment ||
    !/^\d+(\.\d+){0,2}$/.test(deployment) ||
    Number(deployment.split(".")[0]) < minimum
  ) {
    throw setupError(
      `This recipe requires ${platform} ${minimum} or newer in the selected configuration.`,
    );
  }
  const sdkAction = scaffoldSDK({
    path: `${selection.project}/project.${input.projectFormat}`,
    source: input.projectSource,
    targetId: selection.targetId,
    targetName: selection.targetName,
    managedBy: input.managedBy,
    products: input.products,
    minimumVersion: input.minimumVersion,
  });
  const postInstructions = [
    `Settings inspected only for ${selection.targetName}, ${selection.configuration}, ${selection.sdk}. Other configurations and platforms are not verified.`,
    "Resolve Swift packages and build in Xcode. Existing package pins are preserved; SDK API compatibility has not been verified.",
  ];
  if (sdkAction.type === "skip") postInstructions.push(sdkAction.skipReason);
  postInstructions.push(
    "Complete pending source integration using the handoff's documentation. Manual SDK guide: https://clerk.com/docs/ios/getting-started/quickstart.md?manual=1",
    "Native registration uses the confirmed final Bundle ID and App ID Prefix. DEVELOPMENT_TEAM is not proof of the App ID Prefix; PRODUCT_BUNDLE_IDENTIFIER is not proof of the final Info.plist identity.",
  );
  if (input.products === "ui")
    postInstructions.push(
      "Review enabled sign-in methods and add Sign in with Apple capability if native Apple sign-in is enabled.",
    );
  if (platform === "iOS")
    postInstructions.push(
      "In Signing & Capabilities, add Associated Domains with webcredentials:<frontend-api-host> for the configured Clerk instance.",
    );
  if (platform === "macOS" && settings.ENABLE_APP_SANDBOX === "YES")
    postInstructions.push(
      "Enable Outgoing Connections (Client) under App Sandbox in Signing & Capabilities.",
    );
  const entitlements = settings.CODE_SIGN_ENTITLEMENTS;
  if (entitlements)
    postInstructions.push(
      `Selected entitlement setting: ${relative(selection.root, resolve(settings.SRCROOT ?? resolve(selection.root, dirname(selection.project)), entitlements))}. Contents and shared ownership are not inspected or modified.`,
    );
  return { actions: [sdkAction], postInstructions };
}
