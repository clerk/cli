/**
 * Release binaries are compiled with `--define CLI_VERSION="x.y.z"`, so the
 * global holds the published version. Everything else (`bun run dev`, a
 * `bun link`ed checkout on your PATH, or a local `build:compile`) reports a dev
 * version derived from the checkout it was transpiled or compiled from:
 *
 *   3.0.0-dev.20260803.f51f1e4          clean tree at commit f51f1e4
 *   3.0.0-dev.20260803.f51f1e4.dirty    ...with uncommitted changes
 *   3.0.0-dev                           git unavailable, or not run from a checkout
 *
 * A Bun macro computes the fallback before the CLI starts and inlines the
 * result into the module. Compiled binaries therefore retain their checkout
 * metadata without executing Git commands at runtime.
 *
 * Anything that displays a version (`--version`, the outbound user agent, or
 * MCP client info) reads `CURRENT_VERSION`, which prefers an injected version
 * even when that is itself a dev version. `IS_DEV_BUILD` is computed at the
 * same time so runtime consumers do not need to classify the version.
 *
 * Two callers care about the dev/release distinction rather than the string:
 * `credential-store` namespaces the macOS keychain away from release builds,
 * and `update-check` suppresses update prompts. Both read
 * `IS_DEV_BUILD`.
 */

import { resolveDevVersionAtBuildTime } from "./version.macro.ts" with { type: "macro" };

const DEV_TAG = "dev";

function isDevVersion(version: string): boolean {
  const dash = version.indexOf("-");
  if (dash === -1) return false;
  const prerelease = version.slice(dash + 1);
  return prerelease === DEV_TAG || prerelease.startsWith(`${DEV_TAG}.`);
}

// The `CLI_VERSION` check must live in module code, not inside the macro: Bun
// 1.4.0 no longer substitutes `--define` globals during macro execution. The
// macro contributes only the checkout-derived fallback (always a dev version);
// an injected version is classified by the one-line scan above at module load.
const currentVersion =
  typeof CLI_VERSION === "undefined" ? resolveDevVersionAtBuildTime() : CLI_VERSION;
const isDevBuild = typeof CLI_VERSION === "undefined" ? true : isDevVersion(CLI_VERSION);

/**
 * The version embedded while this module was transpiled or compiled.
 */
export const CURRENT_VERSION = currentVersion;

/**
 * Whether the current build carries a development version.
 */
export const IS_DEV_BUILD = isDevBuild;
