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
 * MCP client info) calls `getCurrentVersion()`, which prefers an injected
 * version even when that is itself a dev version.
 *
 * Two callers care about the dev/release distinction rather than the string:
 * `credential-store` namespaces the macOS keychain away from release builds,
 * and `update-check` suppresses update prompts. Both go through
 * `resolveCliVersion` / `isDevVersion` rather than matching a fixed constant.
 */

import { resolveDevVersionAtBuildTime } from "./version.macro.ts" with { type: "macro" };

const DEV_TAG = "dev";
const CURRENT_VERSION =
  typeof CLI_VERSION === "undefined" ? resolveDevVersionAtBuildTime() : CLI_VERSION;

/**
 * True for any version whose prerelease starts with `dev` — the shape every
 * unversioned build reports. Real prereleases (`-canary.*`, `-snapshot.*`) and
 * stable versions are not dev.
 */
export function isDevVersion(version: string): boolean {
  const dash = version.indexOf("-");
  if (dash === -1) return false;
  const prerelease = version.slice(dash + 1);
  return prerelease === DEV_TAG || prerelease.startsWith(`${DEV_TAG}.`);
}

/**
 * Resolve the current CLI version, or `undefined` when running an unversioned
 * dev build. Anything that wants to *display* a version should call
 * `getCurrentVersion()`; anything that wants to *decide* whether this binary is
 * meaningfully versioned should check for `undefined` here.
 */
export function resolveCliVersion(): string | undefined {
  if (isDevVersion(CURRENT_VERSION)) return undefined;
  return CURRENT_VERSION;
}

/**
 * Return the version embedded while this module was transpiled or compiled.
 */
export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}
