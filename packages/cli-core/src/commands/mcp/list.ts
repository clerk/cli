/**
 * `clerk mcp list` — show Clerk-named entries across detected MCP clients.
 *
 * Walks the registry, reads each client's config (if present), and reports
 * any entry whose name is `clerk` or whose URL hostname is under `clerk.com`.
 */

import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { withGutter } from "../../lib/spinner.ts";
import { ui } from "../../lib/ui.ts";
import type { ListEntry } from "./clients/types.ts";
import { collectEntries } from "./collect.ts";
import { wantsJson, type McpOptions } from "./shared.ts";

const COLUMN_PADDING = 2;

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((v) => v.length)) + COLUMN_PADDING;
}

function formatTable(entries: ListEntry[]): void {
  const clientWidth = columnWidth(
    "CLIENT",
    entries.map((e) => e.client),
  );
  const nameWidth = columnWidth(
    "NAME",
    entries.map((e) => e.name),
  );
  const urlWidth = columnWidth(
    "URL",
    entries.map((e) => e.url),
  );

  const header = `${"CLIENT".padEnd(clientWidth)}${"NAME".padEnd(nameWidth)}${"URL".padEnd(urlWidth)}PATH`;
  const rows = entries.map((e) => {
    const client = cyan(e.client.padEnd(clientWidth));
    const name = e.name.padEnd(nameWidth);
    const url = e.url.padEnd(urlWidth);
    return `${client}${name}${url}${dim(e.configPath)}`;
  });

  ui.message([dim(header), ...rows]);
}

export async function mcpList(options: McpOptions = {}): Promise<void> {
  // Unreadable configs are warned per client by collectEntries (stderr) and
  // carried in `failures` so JSON/agent consumers see them structurally too.
  const { entries: all, failures } = await collectEntries(process.cwd());

  if (wantsJson(options)) {
    log.data(
      JSON.stringify(
        { entries: all, failures: failures.map((f) => ({ client: f.client, error: f.message })) },
        null,
        2,
      ),
    );
    return;
  }

  await withGutter("Listing Clerk MCP entries", async ({ setNextSteps }) => {
    if (all.length === 0) {
      // An unreadable config is not "nothing installed" — an entry may be
      // hiding inside it. Don't claim a clean slate we couldn't verify.
      if (failures.length > 0) {
        const clients = failures.map((f) => f.displayName).join(", ");
        ui.warn(
          `Some MCP configs could not be read (${clients}) — fix or remove them, then re-run \`clerk mcp list\`.`,
        );
        return;
      }
      ui.warn("No Clerk MCP entries found. Run `clerk mcp install` to register one.");
      return;
    }
    formatTable(all);
    ui.message(`${all.length} entr${all.length === 1 ? "y" : "ies"}`);
    setNextSteps([
      "Verify a server is reachable with `clerk doctor`.",
      "Remove an entry with `clerk mcp uninstall`.",
    ]);
  });
}
