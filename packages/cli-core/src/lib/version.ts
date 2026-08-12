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

import { resolveVersionAtBuildTime } from "./version.macro.ts" with { type: "macro" };

const { currentVersion, isDevBuild } = resolveVersionAtBuildTime();

/**
 * The version embedded while this module was transpiled or compiled.
 */
export const CURRENT_VERSION = currentVersion;

/**
 * Whether the current build carries a development version.
 */
export const IS_DEV_BUILD = isDevBuild;
