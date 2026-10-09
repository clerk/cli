/**
 * `clerk mcp install` — register the Clerk remote MCP server in supported clients.
 *
 * URL resolution: `CLERK_MCP_URL` > active env profile `mcpUrl` > Clerk's hosted server.
 * Every client gets a native Streamable HTTP entry with the resolved URL
 * embedded, and runs the OAuth sign-in itself — so switching env profiles
 * means re-running install.
 * Target clients: `--client <id>` (repeatable) > `--all` > human picker > all detected (agent mode).
 * Install always converges: whatever entry exists under the name is replaced,
 * including a clerk 3.x `clerk mcp run` bridge entry (reported as `migrated`).
 * Clients with their own CLI (claude, gemini, vscode, openclaw, hermes) are
 * registered by shelling out to it; Codex (whose CLI add blocks on a browser
 * login) and the rest get their config file written directly.
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
import type { McpClient, McpServerEntry, UpsertResult } from "./clients/types.ts";

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

/** An upsert result, flagged when it replaced a clerk 3.x bridge entry. */
type InstallResult = UpsertResult & { migrated: boolean };

function printResult(client: McpClient, result: InstallResult): void {
  const note = result.migrated ? dim(" (replaced the `clerk mcp run` bridge)") : "";
  log.info(`${client.displayName} → ${dim(result.configPath)}: ${green(result.status)}${note}`);
}

// Best-effort: an unreadable config can't hold a detectable legacy entry, and
// the upsert that follows surfaces the read error itself.
async function hasLegacyEntry(client: McpClient, name: string, cwd: string): Promise<boolean> {
  try {
    const entries = await client.list(cwd);
    return entries.some((entry) => entry.name === name && entry.legacy);
  } catch {
    return false;
  }
}

async function install(
  client: McpClient,
  entry: McpServerEntry,
  cwd: string,
): Promise<InstallResult> {
  const migrated = await hasLegacyEntry(client, entry.name, cwd);
  const result = await client.upsert(entry, cwd);
  return { ...result, migrated };
}

type ClientUpsert = { client: McpClient; result: InstallResult };

// Registering the entry isn't enough — the editor must reload before it
// connects (and sign in, if the server requires it). Surface that for every
// client we just installed into, so "installed" doesn't read as "done and
// working".
function installNextSteps(settled: ClientUpsert[], name: string): string[] {
  return settled.map(({ client }) => `${client.displayName}: ${client.activation(name)}`);
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
      const outcome = await settleClients(clients, async (c) => install(c, { name, url }, cwd));
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
      const steps = installNextSteps(succeeded, name);
      if (steps.length > 0) setNextSteps(steps);
    },
    { skip: json },
  );
}
