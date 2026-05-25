import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { mcpInstall } from "./install.ts";
import { mcpList } from "./list.ts";
import { mcpUninstall } from "./uninstall.ts";
import { CLIENT_IDS } from "./clients/registry.ts";

export const mcp = {
  install: mcpInstall,
  list: mcpList,
  uninstall: mcpUninstall,
};
export { CLIENT_IDS } from "./clients/registry.ts";

function collectOptionValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerMcp(program: Program): void {
  const mcpCmd = program
    .command("mcp")
    .description("Manage the Clerk remote MCP server connection for AI editors and CLIs")
    .setExamples([
      { command: "clerk mcp install", description: "Install into all detected MCP clients" },
      { command: "clerk mcp install --client cursor", description: "Install into Cursor only" },
      { command: "clerk mcp list", description: "Show registered Clerk entries" },
      { command: "clerk mcp uninstall", description: "Remove the Clerk entry from all clients" },
    ]);

  mcpCmd
    .command("install")
    .description("Register the Clerk remote MCP server in supported clients")
    .addOption(
      createOption("--client <id>", "MCP client to target (repeatable). Default: all detected.")
        .choices([...CLIENT_IDS])
        .argParser(collectOptionValues)
        .default([] as string[]),
    )
    .option("--url <url>", "Override the MCP server URL (default: from active env profile)")
    .option("--name <name>", 'Entry name in the client config (default: "clerk")')
    .option("--all", "Install into every detected client without prompting")
    .option("--force", "Overwrite an existing entry pointing at a different URL")
    .option("--json", "Output as JSON")
    .setExamples([
      {
        command: "clerk mcp install",
        description: "Pick clients interactively (or all in agent mode)",
      },
      { command: "clerk mcp install --all", description: "Install into every detected client" },
      {
        command: "clerk mcp install --client cursor --client vscode",
        description: "Install into specific clients",
      },
    ])
    .action((options) => mcp.install(options));

  mcpCmd
    .command("list")
    .description("List Clerk MCP entries registered across detected clients")
    .option("--json", "Output as JSON")
    .setExamples([{ command: "clerk mcp list", description: "List Clerk entries everywhere" }])
    .action((options) => mcp.list(options));

  mcpCmd
    .command("uninstall")
    .description("Remove the Clerk MCP entry from supported clients")
    .addOption(
      createOption("--client <id>", "MCP client to target (repeatable). Default: all clients.")
        .choices([...CLIENT_IDS])
        .argParser(collectOptionValues)
        .default([] as string[]),
    )
    .option("--name <name>", 'Entry name to remove (default: "clerk")')
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk mcp uninstall", description: "Remove from every client" },
      { command: "clerk mcp uninstall --client cursor", description: "Remove from Cursor only" },
    ])
    .action((options) => mcp.uninstall(options));
}
