/**
 * `clerk doctor` MCP reachability check.
 *
 * Kept in its own file — rather than `checks.ts` — so the doctor check graph
 * doesn't import `mcp/shared.ts` (env profiles, prompts) and the module cycle
 * that comes with it. Imports only the light `collect`/`probe` helpers.
 */

import { collectEntries } from "../mcp/collect.ts";
import { probeMcp, type McpProbeResult } from "../mcp/probe.ts";
import type { CheckResult } from "./types.ts";

const NAME = "MCP server";

type UrlProbe = { url: string; result: McpProbeResult };

function describeReachable(probes: UrlProbe[]): string {
  return probes
    .map(({ url, result }) => (result.ok ? `${result.serverName} (${url})` : url))
    .join(", ");
}

function describeFailure(result: McpProbeResult): string {
  if (result.ok) return "unknown";
  if (result.error !== undefined) return result.error;
  return result.status !== undefined ? `HTTP ${result.status}` : "unknown";
}

export async function checkMcp(): Promise<CheckResult> {
  // Only meaningful if the user actually registered a Clerk MCP entry —
  // otherwise skip silently rather than probing a server they don't use.
  const entries = await collectEntries(process.cwd());
  if (entries.length === 0) {
    return { name: NAME, status: "pass", message: "Skipped (no Clerk MCP entry installed)" };
  }

  // Clients can point at different URLs (e.g. local dev in one, hosted in
  // another), so probe every distinct one — a healthy first entry must not mask
  // a broken second.
  const urls = [...new Set(entries.map((e) => e.url))];
  const probes = await Promise.all(urls.map(async (url) => ({ url, result: await probeMcp(url) })));

  const unreachable = probes.find(({ result }) => !result.ok);
  if (!unreachable) {
    return { name: NAME, status: "pass", message: `Reachable — ${describeReachable(probes)}` };
  }

  const subject =
    probes.length === 1 ? "Configured MCP server is" : "One or more configured MCP servers are";
  return {
    name: NAME,
    status: "warn",
    message: `${subject} not reachable (${unreachable.url})`,
    detail: describeFailure(unreachable.result),
    remedy: "Verify the server is running, or re-run `clerk mcp install` if the URL changed.",
  };
}
