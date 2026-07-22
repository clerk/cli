/**
 * `clerk mcp install` — register the Clerk remote MCP server in supported clients.
 *
 * URL resolution: `CLERK_MCP_URL` > active env profile `mcpUrl` > Clerk's hosted server.
 * The URL is resolved at bridge runtime, not embedded in the stored config entry.
 * Target clients: `--client <id>` (repeatable) > `--all` > human picker > all detected (agent mode).
 * Install always converges: whatever entry exists under the name is replaced.
 * Clients with their own CLI (claude, gemini, codex, vscode, openclaw, hermes)
 * are registered by shelling out to it; the rest get their config file written
 * directly.
 */

import { log } from "../../lib/log.ts";
import { cyan, dim, green } from "../../lib/color.ts";
import { withGutter } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import {
  failWhenAllFailed,
  pickClients,
  resolveName,
  resolveUrl,
  settleClients,
  targetClients,
  wantsJson,
  type McpOptions,
} from "./shared.ts";
import { detectInstalledClients } from "./clients/registry.ts";
import type { McpClient, UpsertResult } from "./clients/types.ts";

async function chooseClients(options: McpOptions, cwd: string): Promise<McpClient[]> {
  // Only agent mode implies "no picker" — `--json` is an output format, not a
  // targeting choice, so a human passing it still gets the interactive picker
  // rather than a surprise install into every detected client.
  if (options.client?.length || options.all || isAgent()) {
    return targetClients(options, cwd);
  }
  const detected = await detectInstalledClients(cwd);
  // No clients on the system isn't a pickable state — defer to `targetClients`,
  // which throws `MCP_NO_CLIENT_DETECTED` with the supported list and the
  // `--client` escape hatch, instead of the picker's empty-selection message.
  if (detected.length === 0) return targetClients(options, cwd);
  return pickClients(detected, "Select MCP clients to install into:", {
    autoSelectSingle: true,
  });
}

function printResult(client: McpClient, result: UpsertResult): void {
  log.info(`${client.displayName} → ${dim(result.configPath)}: ${green(result.status)}`);
}

type ClientUpsert = { client: McpClient; result: UpsertResult };

// Registering the entry isn't enough — the editor must reload before it
// connects (and sign in, if the server requires it). Surface that for every
// client we just installed into, so "installed" doesn't read as "done and
// working".
function installNextSteps(settled: ClientUpsert[]): string[] {
  return settled.map(({ client }) => `${client.displayName}: ${client.activation}`);
}

export async function mcpInstall(options: McpOptions = {}): Promise<void> {
  const url = resolveUrl(options);
  const name = resolveName(options);
  const cwd = process.cwd();
  const clients = await chooseClients(options, cwd);
  const json = wantsJson(options);

  if (clients.length === 0 && json) {
    log.data(JSON.stringify({ url, name, results: [] }, null, 2));
    return;
  }
  if (clients.length === 0) {
    log.warn("No MCP clients selected.");
    return;
  }

  await withGutter(
    `Installing Clerk MCP (${cyan(url)})`,
    async ({ setNextSteps }) => {
      const outcome = await settleClients(clients, (c) => c.upsert({ name, url }, cwd));
      const { succeeded, failed } = outcome;
      if (json) {
        log.data(
          JSON.stringify(
            { url, name, results: succeeded.map((s) => s.result), failures: failed },
            null,
            2,
          ),
        );
        failWhenAllFailed(outcome, json);
        return;
      }
      failWhenAllFailed(outcome, json);
      succeeded.forEach(({ client, result }) => printResult(client, result));
      const steps = installNextSteps(succeeded);
      if (steps.length > 0) setNextSteps(steps);
    },
    { skip: json },
  );
}
