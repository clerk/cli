import type { Program } from "../../cli-program.ts";
import { check } from "./mcp/check.ts";
import { configure } from "./mcp/configure.ts";

export function registerAgents(program: Program): void {
  const agents = program
    .command("agents")
    .description("Set up Clerk auth for agent tooling you build, such as MCP servers");

  const mcp = agents
    .command("mcp")
    .description("Use Clerk as the OAuth authorization server of your own MCP server");

  mcp
    .command("configure")
    .description(
      "Register an MCP server URL as an OAuth resource so Clerk issues tokens for it; the first server on an instance also turns on the audience claim and client ID metadata documents",
    )
    .argument("<url>", "Public https URL of the MCP server, e.g. https://mcp.example.com/mcp")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--json", "Output the result as JSON")
    .setExamples([
      {
        command: "clerk agents mcp configure https://mcp.example.com/mcp",
        description: "Register an MCP server on the linked development instance",
      },
      {
        command: "clerk agents mcp configure https://mcp.example.com/mcp --instance prod",
        description: "Register it on production",
      },
      {
        command: "clerk agents mcp configure https://mcp.example.com/mcp --app app_123 --json",
        description: "Target an application directly and emit JSON",
      },
    ])
    .action(configure);

  mcp
    .command("check")
    .description(
      "Check an MCP server's Clerk setup: the resource is registered, the audience claim and client registration are on, and its protected resource metadata is reachable. Sends no MCP request",
    )
    .argument(
      "[url]",
      "Registered MCP server URL to check; optional when the instance has exactly one",
    )
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--json", "Output the result as JSON")
    .setExamples([
      {
        command: "clerk agents mcp check https://mcp.example.com/mcp",
        description: "Check an MCP server on the linked development instance",
      },
      {
        command: "clerk agents mcp check --instance prod --json",
        description: "Check production's only MCP server and emit JSON",
      },
    ])
    .action(check);
}
