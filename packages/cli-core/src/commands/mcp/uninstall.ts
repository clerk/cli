/**
 * `clerk mcp uninstall` — remove the `clerk` MCP entry from supported clients.
 */

import { cyan, dim, green, yellow } from "../../lib/color.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { withGutter } from "../../lib/spinner.ts";
import { CLIENTS } from "./clients/registry.ts";
import type { McpClient, RemoveResult } from "./clients/types.ts";
import {
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

export async function mcpUninstall(options: McpOptions = {}): Promise<void> {
  const name = resolveName(options);
  const cwd = process.cwd();
  const clients =
    options.client && options.client.length > 0
      ? resolveClients(options.client)
      : Array.from(CLIENTS);
  const json = wantsJson(options);

  const settled = await settleClients(clients, (c) => c.remove(name, cwd));
  const results = settled.map((s) => s.result);
  const removedCount = results.filter((r) => r.removed).length;
  const notInstalled = new CliError(`No MCP entry named "${name}" found in any client.`, {
    code: ERROR_CODE.MCP_NOT_INSTALLED,
  });

  if (json) {
    log.data(JSON.stringify({ name, results }, null, 2));
    if (removedCount === 0) throw notInstalled;
    return;
  }

  // Removing the config entry doesn't drop a live editor session — it lingers
  // until the editor reloads. Surface that as a next step per removed client.
  await withGutter(`Removing MCP entry ${cyan(name)}`, async ({ setNextSteps }) => {
    if (removedCount === 0) throw notInstalled;
    settled.forEach(({ client, result }) => printResult(client, result));
    setNextSteps(
      settled
        .filter(({ result }) => result.removed)
        .map(({ client }) => `Reload ${client.displayName} to drop the active connection.`),
    );
  });
}
