/**
 * `clerk init`'s flags, by option name, for the code that checks or repeats
 * them. Every flag `registerInit` registers is on exactly one of
 * `RERUN_FLAGS` and `NOT_RERUN`; `rerun.test.ts` fails on one that's on
 * neither, so a new flag can't silently drop out of the rerun.
 */

/** The native Apple flags, by option name, in `clerk init --help`'s order. */
export const APPLE_FLAGS = [
  ["xcodeProject", "--xcode-project"],
  ["xcodeTarget", "--xcode-target"],
  ["xcodeConfiguration", "--xcode-configuration"],
  ["appleSdk", "--apple-sdk"],
  ["bundleId", "--bundle-id"],
  ["appIdPrefix", "--app-id-prefix"],
  ["signInWithApple", "--sign-in-with-apple"],
  ["prebuiltAuthUi", "--prebuilt-auth-ui"],
] as const;

/**
 * The flags the rerun repeats, by option name, in `clerk init --help`'s
 * order. `skills` is `--no-skills`: repeated when it's false.
 */
export const RERUN_FLAGS = [
  ["framework", "--framework"],
  ["pm", "--pm"],
  ["login", "--login"],
  ["json", "--json"],
  ...APPLE_FLAGS,
  ["yes", "--yes"],
  ["skills", "--no-skills"],
] as const;

/** The flags the rerun leaves out, and why. */
export const NOT_RERUN = {
  "--app": "it links that app directly, so `link` never stops",
  "--accountless": "it never links",
  "--keyless": "the deprecated alias of `--accountless`, which never links",
  "--template": "it applies only to the accountless flow, which never links",
  "--fresh": "it applies only to the accountless flow, which never links",
  "--dry-run": "it returns before linking",
  "--starter":
    "it would scaffold the project again; the rerun runs in the project's folder instead",
  "--name": "it names the project `--starter` creates",
} as const;
