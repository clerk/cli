/**
 * `clerk doctor` MCP reachability check.
 *
 * Kept in its own file — rather than `checks.ts` — so the doctor check graph
 * doesn't import `mcp/shared.ts` (env profiles, prompts) and the module cycle
 * that comes with it. Imports only the light `collect`/`probe` helpers.
 */

import { collectEntries } from "../mcp/collect.ts";
import { probeMcp } from "../mcp/probe.ts";
import type { CheckResult } from "./types.ts";

const NAME = "MCP server";

export async function checkMcp(): Promise<CheckResult> {
  // Only meaningful if the user actually registered a Clerk MCP entry —
  // otherwise skip silently rather than probing a server they don't use.
  const entries = await collectEntries(process.cwd());
  if (entries.length === 0) {
    return { name: NAME, status: "pass", message: "Skipped (no Clerk MCP entry installed)" };
  }

  const url = entries[0]!.url;
  const result = await probeMcp(url);
  if (result.ok) {
    return { name: NAME, status: "pass", message: `Reachable — ${result.serverName} (${url})` };
  }

  const detail =
    result.error ?? (result.status !== undefined ? `HTTP ${result.status}` : "unknown");
  return {
    name: NAME,
    status: "warn",
    message: `Configured MCP server is not reachable (${url})`,
    detail,
    remedy: "Verify the server is running, or re-run `clerk mcp install` if the URL changed.",
  };
}
