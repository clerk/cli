import type { Command } from "@commander-js/extra-typings";
import { pull } from "./pull.ts";

export function registerEnv(program: Command): void {
  const env = program
    .command("env")
    .description("Manage environment variables")
    .setExamples([
      { command: "clerk env pull", description: "Pull dev keys to .env.local" },
      { command: "clerk env pull --instance prod", description: "Pull production keys" },
      { command: "clerk env pull --file .env", description: "Write to a specific file" },
      { command: "clerk env pull --app app_abc123", description: "Target a specific application" },
    ]);

  env
    .command("pull")
    .description("Pull environment variables from Clerk to .env.local")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Target env file (default: auto-detect)")
    .setExamples([
      { command: "clerk env pull", description: "Pull dev keys to .env.local" },
      { command: "clerk env pull --instance prod", description: "Pull production keys" },
      { command: "clerk env pull --file .env", description: "Write to a specific file" },
      { command: "clerk env pull --app app_abc123", description: "Target a specific application" },
    ])
    .action(pull);
}
