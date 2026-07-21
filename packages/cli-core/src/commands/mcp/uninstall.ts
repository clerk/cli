/**
 * `clerk mcp uninstall` — remove the `clerk` MCP entry from supported clients.
 */

import { cyan, dim, green, yellow } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { withGutter } from "../../lib/spinner.ts";
import { CLIENTS } from "./clients/registry.ts";
import { collectEntries } from "./collect.ts";
import type { McpClient, RemoveResult } from "./clients/types.ts";
import {
  pickClients,
  resolveClients,
  resolveName,
  settleClients,
  wantsJson,
  type McpOptions,
} from "./shared.ts";

function printResult(client: McpClient, result: RemoveResult): void {
  const label = `${client.displayName} → ${dim(result.configPath)}`;
  log.info(`${label}: ${result.removed ? green("removed") : yellow("not present")}`);
}

function warnNotInstalled(name: string): void {
  log.warn(`No \`${name}\` MCP entry is installed. Run \`clerk mcp install\` to add it.`);
}

async function installedClients(name: string, cwd: string): Promise<McpClient[]> {
  // collectEntries settles per client (an unreadable config warns instead of
  // aborting detection); a failed client is not offered in the picker.
  const { entries, failures } = await collectEntries(cwd);
  const failed = new Set(failures.map((f) => f.client));
  return CLIENTS.filter(
    (client) =>
      !failed.has(client.id) && entries.some((e) => e.client === client.id && e.name === name),
  );
}

// The checked clients are removed; nothing is pre-checked, so the safe default
// (submitting with no selection) removes nothing.
async function pickClientsToRemove(installed: McpClient[], name: string): Promise<McpClient[]> {
  return pickClients(installed, `Select the clients to remove \`${name}\` from:`, {
    required: false,
    preselect: false,
  });
}

async function removeFrom(
  clients: McpClient[],
  name: string,
  cwd: string,
  json: boolean,
): Promise<void> {
  const { succeeded, failed } = await settleClients(clients, (c) => c.remove(name, cwd));
  const results = succeeded.map((s) => s.result);
  const removedCount = results.filter((r) => r.removed).length;

  if (json) {
    log.data(JSON.stringify({ name, results, failures: failed }, null, 2));
    return;
  }

  if (removedCount === 0) {
    warnNotInstalled(name);
    return;
  }

  // Removing the config entry doesn't drop a live editor session — it lingers
  // until the editor reloads. Surface that as a next step per removed client.
  await withGutter(`Removing MCP entry ${cyan(name)}`, async ({ setNextSteps }) => {
    succeeded.forEach(({ client, result }) => printResult(client, result));
    setNextSteps(
      succeeded
        .filter(({ result }) => result.removed)
        .map(({ client }) => `Reload ${client.displayName} to drop the active connection.`),
    );
  });
}

export async function mcpUninstall(options: McpOptions = {}): Promise<void> {
  const name = resolveName(options);
  const cwd = process.cwd();
  const json = wantsJson(options);
  const explicit =
    options.client && options.client.length > 0 ? resolveClients(options.client) : undefined;

  // Non-interactive: explicit `--client`, `--all`, agent mode, or `--json`
  // operate directly on the targeted clients.
  if (json || explicit || options.all) {
    await removeFrom(explicit ?? Array.from(CLIENTS), name, cwd, json);
    return;
  }

  // Human, interactive: pick which installed clients to keep; remove the rest.
  const installed = await installedClients(name, cwd);
  if (installed.length === 0) {
    warnNotInstalled(name);
    return;
  }

  const toRemove = await pickClientsToRemove(installed, name);
  if (toRemove.length === 0) {
    log.info("No clients selected. Nothing removed.");
    return;
  }

  await removeFrom(toRemove, name, cwd, json);
}
