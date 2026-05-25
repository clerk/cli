/**
 * `clerk mcp list` — show Clerk-named entries across detected MCP clients.
 *
 * Walks the registry, reads each client's config (if present), and reports
 * any entry whose name is `clerk` or whose URL hostname is under `clerk.com`.
 */

import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import type { ListEntry } from "./clients/types.ts";
import { collectEntries } from "./collect.ts";
import { printNextSteps, wantsJson, type McpOptions } from "./shared.ts";

const COLUMN_PADDING = 2;

function formatTable(entries: ListEntry[]): void {
  const clientWidth =
    Math.max("CLIENT".length, ...entries.map((e) => e.client.length)) + COLUMN_PADDING;
  const nameWidth = Math.max("NAME".length, ...entries.map((e) => e.name.length)) + COLUMN_PADDING;
  const urlWidth = Math.max("URL".length, ...entries.map((e) => e.url.length)) + COLUMN_PADDING;

  log.data(
    dim(`${"CLIENT".padEnd(clientWidth)}${"NAME".padEnd(nameWidth)}${"URL".padEnd(urlWidth)}PATH`),
  );
  for (const entry of entries) {
    const client = cyan(entry.client.padEnd(clientWidth));
    const name = entry.name.padEnd(nameWidth);
    const url = entry.url.padEnd(urlWidth);
    log.data(`${client}${name}${url}${dim(entry.configPath)}`);
  }
}

export async function mcpList(options: McpOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const all: ListEntry[] = await collectEntries(cwd);

  if (wantsJson(options)) {
    log.data(JSON.stringify(all, null, 2));
    return;
  }

  if (all.length === 0) {
    log.warn("No Clerk MCP entries found. Run `clerk mcp install` to register one.");
    return;
  }

  formatTable(all);
  log.info(`\n${all.length} entr${all.length === 1 ? "y" : "ies"}`);

  printNextSteps([
    "Verify a server is reachable with `clerk doctor`.",
    "Remove an entry with `clerk mcp uninstall`.",
  ]);
}
