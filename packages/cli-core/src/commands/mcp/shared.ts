/**
 * Shared options and helpers for `clerk mcp` subcommands.
 */

import { ttyContext } from "../../lib/listage.ts";
import { getMcpUrl } from "../../lib/environment.ts";
import { CliError, ERROR_CODE, errorMessage, throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { CLIENT_IDS, CLIENTS, detectInstalledClients } from "./clients/registry.ts";
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
  const candidate = options.url ?? getMcpUrl();
  if (!candidate) {
    throw new CliError(
      "No MCP URL available. Set one with `--url`, or switch to an environment whose profile defines `mcpUrl`.",
      { code: ERROR_CODE.MCP_URL_REQUIRED },
    );
  }
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
  return ids.map((id) => {
    const client = byId.get(id);
    if (!client) {
      throwUsageError(
        `Unknown MCP client "${id}". Supported: ${CLIENT_IDS.join(", ")}.`,
        undefined,
        ERROR_CODE.MCP_CLIENT_NOT_SUPPORTED,
      );
    }
    return client;
  });
}

export async function pickClients(detected: McpClient[]): Promise<McpClient[]> {
  if (detected.length === 0) return [];
  if (detected.length === 1) return detected;
  // Imported lazily (like `doctor`/`update` do): a top-level import of
  // `@inquirer/prompts` is resolved at module load, which breaks tests that
  // mock the module with a partial shape that omits `checkbox`.
  const { checkbox } = await import("@inquirer/prompts");
  const tty = ttyContext();
  try {
    const selected = await checkbox<ClientId>(
      {
        message: "Select MCP clients to install into:",
        choices: detected.map((c) => ({
          name: `${c.displayName} (${c.scope})`,
          value: c.id,
          checked: true,
        })),
        required: true,
      },
      tty ? { input: tty.input } : undefined,
    );
    return resolveClients(selected);
  } finally {
    tty?.close();
  }
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

/** Render a "Next steps:" block to stderr (human mode). No-op for an empty list. */
export function printNextSteps(lines: string[]): void {
  if (lines.length === 0) return;
  log.blank();
  log.info("Next steps:");
  for (const line of lines) log.info(`  ${line}`);
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
  settled.forEach((outcome, i) => {
    const client = clients[i]!;
    if (outcome.status === "fulfilled") {
      succeeded.push({ client, result: outcome.value });
      return;
    }
    failures.push(outcome.reason);
    log.warn(`${client.displayName}: ${errorMessage(outcome.reason)}`);
  });
  if (succeeded.length === 0 && failures.length > 0) throw failures[0];
  return succeeded;
}
