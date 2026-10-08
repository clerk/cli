import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

export type IOSNativePlatform = "ios" | "macos";

/** A setup condition the user can act on, as opposed to a bug in the CLI. */
export function setupError(message: string, stale = false): CliError {
  return new CliError(message, {
    code: stale ? ERROR_CODE.IOS_SETUP_STALE : ERROR_CODE.IOS_SETUP_BLOCKED,
  });
}
