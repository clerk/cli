/**
 * Identifies the CLI in outbound HTTP calls so Clerk's edge can route or filter
 * CLI traffic separately (e.g. to dedicated Cloud Run services). Without this
 * we fall through to Bun's default `User-Agent: Bun/<version>`, which is
 * indistinguishable from any other Bun-based client.
 *
 * Format: `Clerk-CLI/<version> (Bun/<bun-version>; <platform>-<arch>[; ci])[ AIAgent/<agent>]`
 *   - <platform>: darwin | linux | win32 | …  (process.platform)
 *   - <arch>:     arm64 | x64 | …             (process.arch)
 *   - `ci` segment is appended when running under a recognized CI environment.
 *   - ` AIAgent/<agent>` product token is appended when an AI agent is detected.
 */

import { detectAiAgent, type EnvLike } from "./env-signals.ts";
import { DEV_CLI_VERSION, resolveCliVersion } from "./version.ts";

export function buildUserAgent(env: EnvLike = process.env): string {
  const version = resolveCliVersion() ?? DEV_CLI_VERSION;
  const segments = [`Bun/${Bun.version}`, `${process.platform}-${process.arch}`];
  if (env.CI) segments.push("ci");
  const agent = detectAiAgent(env);
  const agentToken = agent ? ` AIAgent/${agent}` : "";
  return `Clerk-CLI/${version} (${segments.join("; ")})${agentToken}`;
}
