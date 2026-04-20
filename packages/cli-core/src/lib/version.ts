/**
 * The string printed by `clerk --version` when the compile-time `CLI_VERSION`
 * global is undefined (dev builds via `bun run dev`). Used in two places that
 * must stay in lockstep: the CLI's own version flag fallback, and the skill
 * installer's detection of "this binary isn't really versioned" so it can tell
 * the installed skill to pin against `latest` instead of a fake number.
 */
export const DEV_CLI_VERSION = "0.0.0-dev";

/**
 * Resolve the current CLI version, or `undefined` when running an unversioned
 * dev build. Anything downstream that wants to *display* a version should use
 * `DEV_CLI_VERSION` as a fallback; anything that wants to *decide* whether
 * this binary is meaningfully versioned should check for `undefined` here.
 */
export function resolveCliVersion(): string | undefined {
  if (typeof CLI_VERSION === "undefined") return undefined;
  if (CLI_VERSION === DEV_CLI_VERSION) return undefined;
  return CLI_VERSION;
}
