/**
 * Shared options and helpers for `clerk mcp` subcommands.
 */

import { getMcpUrl } from "../../lib/environment.ts";
import { CliError, ERROR_CODE, errorMessage, throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { CLIENT_ALIASES, CLIENT_IDS, CLIENTS, detectInstalledClients } from "./clients/registry.ts";
import type { ClientId, McpClient } from "./clients/types.ts";

export type McpOptions = {
  json?: boolean;
  url?: string;
  name?: string;
  /** Raw client IDs from the CLI. Validated through {@link resolveClients}. */
  client?: string[];
  all?: boolean;
  force?: boolean;
};

export const DEFAULT_ENTRY_NAME = "clerk";

export function resolveUrl(options: McpOptions): string {
  // `getMcpUrl()` always resolves to a usable URL (Clerk's hosted server by
  // default), so the only failure mode left is an explicit `--url` that is
  // malformed or uses a non-network scheme.
  const candidate = options.url ?? getMcpUrl();
  // Reject non-network schemes so a stray `file:` or `data:` URL can't be
  // written into an editor's MCP config or probed by `doctor` via fetch.
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throwUsageError(`Invalid MCP URL "${candidate}".`, undefined, ERROR_CODE.MCP_URL_REQUIRED);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throwUsageError(
      `MCP URL must use http or https — got "${parsed.protocol}".`,
      undefined,
      ERROR_CODE.MCP_URL_REQUIRED,
    );
  }
  return candidate;
}

export function resolveName(options: McpOptions): string {
  return options.name ?? DEFAULT_ENTRY_NAME;
}

export function resolveClients(ids: readonly string[]): McpClient[] {
  const byId = new Map<string, McpClient>(CLIENTS.map((c) => [c.id, c]));
  const seen = new Set<ClientId>();
  // Dedupe by canonical id so `--client copilot --client vscode` (aliases of the
  // same client) or a repeated flag operates on each client once.
  return ids.flatMap((id) => {
    const client = byId.get(CLIENT_ALIASES[id] ?? id);
    if (!client) {
      throwUsageError(
        `Unknown MCP client "${id}". Supported: ${CLIENT_IDS.join(", ")}.`,
        undefined,
        ERROR_CODE.MCP_CLIENT_NOT_SUPPORTED,
      );
    }
    if (seen.has(client.id)) return [];
    seen.add(client.id);
    return [client];
  });
}

export async function pickClients(
  detected: McpClient[],
  message: string,
  options: { autoSelectSingle?: boolean; required?: boolean; preselect?: boolean } = {},
): Promise<McpClient[]> {
  if (detected.length === 0) return [];
  if (detected.length === 1 && options.autoSelectSingle) return detected;
  // Imported lazily (like `doctor` does) so the prompt layer stays off the
  // module-load path for non-interactive callers and tests.
  const { multiselect } = await import("../../lib/prompts.ts");
  const preselect = options.preselect ?? true;
  const selected = await multiselect<ClientId>({
    message,
    options: detected.map((c) => ({ value: c.id, label: `${c.displayName} (${c.scope})` })),
    initialValues: preselect ? detected.map((c) => c.id) : [],
    required: options.required ?? true,
  });
  return resolveClients(selected);
}

export async function targetClients(options: McpOptions, cwd: string): Promise<McpClient[]> {
  if (options.client && options.client.length > 0) {
    return resolveClients(options.client);
  }
  const detected = await detectInstalledClients(cwd);
  if (detected.length === 0) {
    throw new CliError(
      "No supported MCP clients detected. Install one of: " +
        CLIENTS.map((c) => c.displayName).join(", ") +
        ", or target a specific client with `--client <id>`.",
      { code: ERROR_CODE.MCP_NO_CLIENT_DETECTED },
    );
  }
  return detected;
}

export function wantsJson(options: McpOptions): boolean {
  return Boolean(options.json) || isAgent();
}

/**
 * Run an async op against each client without letting one client's failure
 * abort the rest — `Promise.all` is fail-fast and would discard every other
 * client's result on the first rejection. Failures are warned per-client;
 * successes are returned. If *every* client failed, the first error is
 * rethrown so the command still exits non-zero with a real message.
 */
export async function settleClients<T>(
  clients: readonly McpClient[],
  op: (client: McpClient) => Promise<T>,
): Promise<{ client: McpClient; result: T }[]> {
  const settled = await Promise.allSettled(clients.map(op));
  const succeeded: { client: McpClient; result: T }[] = [];
  const failures: unknown[] = [];
  for (const [i, outcome] of settled.entries()) {
    const client = clients[i]!;
    if (outcome.status === "fulfilled") {
      succeeded.push({ client, result: outcome.value });
      continue;
    }
    failures.push(outcome.reason);
    log.warn(`${client.displayName}: ${errorMessage(outcome.reason)}`);
  }
  if (succeeded.length === 0 && failures.length > 0) throw failures[0];
  return succeeded;
}
