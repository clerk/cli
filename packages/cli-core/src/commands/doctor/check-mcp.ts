/**
 * `clerk doctor` MCP reachability check.
 *
 * Kept in its own file — rather than `checks.ts` — so the doctor check graph
 * doesn't import `mcp/shared.ts` (env profiles, prompts) and the module cycle
 * that comes with it. Imports only the light `collect`/`probe` helpers.
 */

import { collectEntries } from "../mcp/collect.ts";
import { probeMcp, type McpProbeResult } from "../mcp/probe.ts";
import type { ListEntry } from "../mcp/clients/types.ts";
import type { CheckResult } from "./types.ts";

const NAME = "MCP server";

type UrlProbe = { url: string; result: McpProbeResult };
type ReachableProbe = { url: string; result: Extract<McpProbeResult, { ok: true }> };

// Narrowed to the reachable variant: only called once every probe succeeded.
function describeReachable(probes: ReachableProbe[]): string {
  return probes.map(({ url, result }) => `${result.serverName} (${url})`).join(", ");
}

function describeFailure(result: McpProbeResult): string {
  if (result.ok) return "unknown";
  if (result.error !== undefined) return result.error;
  return result.status !== undefined ? `HTTP ${result.status}` : "unknown";
}

function describeUnreachable(unreachable: UrlProbe[], total: number): string {
  const subject =
    total === 1 ? "Configured MCP server is" : "One or more configured MCP servers are";
  return `${subject} not reachable (${unreachable.map((p) => p.url).join(", ")})`;
}

// Clients can point at different URLs (e.g. local dev in one, hosted in
// another), so probe every distinct one — a healthy first entry must not mask
// a broken second.
async function probeEntries(entries: ListEntry[]): Promise<UrlProbe[]> {
  const urls = [...new Set(entries.map((e) => e.url))];
  return Promise.all(urls.map(async (url) => ({ url, result: await probeMcp(url) })));
}

export async function checkMcp(): Promise<CheckResult> {
  // Only meaningful if the user actually registered a Clerk MCP entry —
  // otherwise skip silently rather than probing a server they don't use.
  const { entries, failures } = await collectEntries(process.cwd());
  const probes = await probeEntries(entries);
  const unreachable = probes.filter((p): p is UrlProbe => !p.result.ok);

  // An unreadable client config is not "nothing installed" — a previously
  // registered entry may be hiding inside it. The stderr warning alone gets
  // clobbered by the doctor spinner, so it must surface in the check result.
  if (failures.length > 0) {
    const clients = failures.map((f) => f.displayName).join(", ");
    return {
      name: NAME,
      status: "warn",
      message: `Could not read the MCP config for ${clients}`,
      detail: [
        ...failures.map((f) => `${f.displayName}: ${f.message}`),
        ...unreachable.map((p) => `${p.url}: ${describeFailure(p.result)}`),
      ].join("; "),
      remedy: "Fix or remove the unreadable config file, then re-run `clerk mcp install`.",
    };
  }

  if (entries.length === 0) {
    return { name: NAME, status: "pass", message: "Skipped (no Clerk MCP entry installed)" };
  }

  if (unreachable.length === 0) {
    const reachable = probes.filter((p): p is ReachableProbe => p.result.ok);
    return { name: NAME, status: "pass", message: `Reachable — ${describeReachable(reachable)}` };
  }

  return {
    name: NAME,
    status: "warn",
    message: describeUnreachable(unreachable, probes.length),
    detail: unreachable.map((p) => `${p.url}: ${describeFailure(p.result)}`).join("; "),
    remedy: "Verify the server is running, or re-run `clerk mcp install` if the URL changed.",
  };
}
