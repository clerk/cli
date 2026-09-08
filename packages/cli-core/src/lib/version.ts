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
 * The `CLI_VERSION` check happens HERE, not in the macro: since Bun 1.4,
 * macros run in a sealed transpiler context that `--define` globals do not
 * reach, while defines still substitute identifiers in transpiled modules
 * like this one. With a define present the ternary below collapses to the
 * injected literal at build time; without one, `typeof` guards the absent
 * global safely.
 *
 * Anything that displays a version (`--version`, the outbound user agent, or
 * MCP client info) reads `CURRENT_VERSION`, which prefers an injected version
 * even when that is itself a dev version. `IS_DEV_BUILD` is derived from the
 * same value at module load — a pure string check, never Git.
 *
 * Two callers care about the dev/release distinction rather than the string:
 * `credential-store` namespaces the macOS keychain away from release builds,
 * and `update-check` suppresses update prompts. Both read
 * `IS_DEV_BUILD`.
 */

import { resolveFallbackVersionAtBuildTime } from "./version.macro.ts" with { type: "macro" };

const DEV_TAG = "dev";

function isDevVersion(version: string): boolean {
  const dash = version.indexOf("-");
  if (dash === -1) return false;
  const prerelease = version.slice(dash + 1);
  return prerelease === DEV_TAG || prerelease.startsWith(`${DEV_TAG}.`);
}

const fallbackVersion = resolveFallbackVersionAtBuildTime();

/**
 * The version embedded while this module was transpiled or compiled.
 */
export const CURRENT_VERSION = typeof CLI_VERSION === "undefined" ? fallbackVersion : CLI_VERSION;

/**
 * Whether the current build carries a development version.
 */
export const IS_DEV_BUILD = isDevVersion(CURRENT_VERSION);
