import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

export type AndroidSdk = "core" | "ui";

export const ANDROID_QUICKSTART = "https://clerk.com/docs/android/getting-started/quickstart";
export const NATIVE_APPLICATIONS_DASHBOARD = "https://dashboard.clerk.com/~/native-applications";

/** A setup condition the user can act on, as opposed to a bug in the CLI. */
export function setupError(message: string, stale = false): CliError {
  return new CliError(message, {
    code: stale ? ERROR_CODE.ANDROID_SETUP_STALE : ERROR_CODE.ANDROID_SETUP_BLOCKED,
  });
}

/** A project layout this setup doesn't edit: says why, and where the manual steps are. */
export function unsupported(reason: string): CliError {
  return setupError(
    `${reason} No Android project files were changed. See ${ANDROID_QUICKSTART} for manual setup.`,
  );
}
