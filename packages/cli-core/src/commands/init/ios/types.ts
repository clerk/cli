import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import type { Selection } from "./plan.ts";

export type IOSNativePlatform = "ios" | "macos";
/** What a target builds for: one platform, or both for an Xcode Multiplatform target. */
export type IOSNativeTargetPlatform = IOSNativePlatform | "multiplatform";

/** How messages name a platform or an SDK: "iOS", "macOS", or "iOS and macOS" for a Multiplatform target. */
export function platformLabel(platform: IOSNativePlatform | Selection["sdk"]): "iOS" | "macOS";
export function platformLabel(
  platform: IOSNativeTargetPlatform | Selection["sdk"] | undefined,
): "iOS" | "macOS" | "iOS and macOS";
export function platformLabel(
  platform: IOSNativeTargetPlatform | Selection["sdk"] | undefined,
): "iOS" | "macOS" | "iOS and macOS" {
  if (platform === "multiplatform") return "iOS and macOS";
  return platform === "macos" || platform === "macosx" ? "macOS" : "iOS";
}

/** A setup condition the user can act on, as opposed to a bug in the CLI. */
export function setupError(message: string, stale = false): CliError {
  return new CliError(message, {
    code: stale ? ERROR_CODE.IOS_SETUP_STALE : ERROR_CODE.IOS_SETUP_BLOCKED,
  });
}
