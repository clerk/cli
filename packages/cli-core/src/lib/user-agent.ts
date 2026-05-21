/**
 * Identifies the CLI in outbound HTTP calls so Clerk's edge can route or filter
 * CLI traffic separately (e.g. to dedicated Cloud Run services). Without this
 * we fall through to Bun's default `User-Agent: Bun/<version>`, which is
 * indistinguishable from any other Bun-based client.
 *
 * Format: `Clerk-CLI/<version> (Bun/<bun-version>; <platform>-<arch>[; ci])`
 *   - <platform>: darwin | linux | win32 | …  (process.platform)
 *   - <arch>:     arm64 | x64 | …             (process.arch)
 *   - `ci` segment is appended when running under a recognized CI environment.
 */

import { DEV_CLI_VERSION, resolveCliVersion } from "./version.ts";

export function buildUserAgent(): string {
  const version = resolveCliVersion() ?? DEV_CLI_VERSION;
  const segments = [`Bun/${Bun.version}`, `${process.platform}-${process.arch}`];
  if (process.env.CI) segments.push("ci");
  return `Clerk-CLI/${version} (${segments.join("; ")})`;
}
