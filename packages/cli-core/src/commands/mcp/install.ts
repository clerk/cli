/**
 * `clerk mcp install` — register the Clerk remote MCP server in supported clients.
 *
 * URL resolution: `--url` > `CLERK_MCP_URL` > active env profile `mcpUrl` > Clerk's hosted server.
 * Target clients: `--client <id>` (repeatable) > `--all` > human picker > all detected (agent mode).
 * Conflict policy: same URL → unchanged; different URL → skip unless `--force`.
 */

import { log } from "../../lib/log.ts";
import { cyan, dim, green, yellow } from "../../lib/color.ts";
import { withGutter } from "../../lib/spinner.ts";
import {
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
  // `wantsJson` covers `--json` and agent mode, so non-interactive callers never
  // block on the picker.
  if (options.client?.length || options.all || wantsJson(options)) {
    return targetClients(options, cwd);
  }
  return pickClients(await detectInstalledClients(cwd), "Select MCP clients to install into:", {
    autoSelectSingle: true,
  });
}

function statusLabel(status: UpsertResult["status"]): string {
  switch (status) {
    case "added":
      return green("added");
    case "updated":
      return green("updated");
    case "unchanged":
      return dim("unchanged");
    case "skipped":
      return yellow("skipped");
  }
}

function printResult(client: McpClient, result: UpsertResult): void {
  const label = `${client.displayName} → ${dim(result.configPath)}`;
  if (result.status === "skipped") {
    log.warn(`${label}: ${statusLabel(result.status)} (${result.reason})`);
    return;
  }
  log.info(`${label}: ${statusLabel(result.status)}`);
}

type ClientUpsert = { client: McpClient; result: UpsertResult };

// Writing the config isn't enough — the editor must reload before it connects
// (and sign in, if the server requires it). Surface that for every client we
// just wrote, so "added" doesn't read as "done and working".
function installNextSteps(settled: ClientUpsert[]): string[] {
  const activated = settled.filter(
    ({ result }) => result.status === "added" || result.status === "updated",
  );
  if (activated.length === 0) return [];
  return [
    ...activated.map(({ client }) => `${client.displayName}: ${client.activation}`),
    "If the server requires authentication, your editor opens a browser to sign in on first connect.",
  ];
}

export async function mcpInstall(options: McpOptions = {}): Promise<void> {
  const url = resolveUrl(options);
  const name = resolveName(options);
  const cwd = process.cwd();
  const clients = await chooseClients(options, cwd);
  const force = Boolean(options.force);
  const json = wantsJson(options);

  if (clients.length === 0) {
    if (json) log.data(JSON.stringify({ url, name, results: [] }, null, 2));
    else log.warn("No MCP clients selected.");
    return;
  }

  await withGutter(
    `Installing Clerk MCP (${cyan(url)})`,
    async ({ setNextSteps }) => {
      const settled = await settleClients(clients, (c) => c.upsert({ name, url }, cwd, force));
      if (json) {
        log.data(JSON.stringify({ url, name, results: settled.map((s) => s.result) }, null, 2));
        return;
      }
      settled.forEach(({ client, result }) => printResult(client, result));
      const steps = installNextSteps(settled);
      if (steps.length > 0) setNextSteps(steps);
    },
    { skip: json },
  );
}
