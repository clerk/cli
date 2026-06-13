import type { Program } from "../../cli-program.ts";
import { configPull } from "./pull.ts";
import { configSchema } from "./schema.ts";
import { configPatch, configPut } from "./push.ts";

export function registerConfig(program: Program): void {
  const config = program
    .command("config")
    .description("Manage instance configuration")
    .setExamples([
      { command: "clerk config pull", description: "Print dev config to stdout" },
      { command: "clerk config pull --instance prod", description: "Pull production config" },
      { command: "clerk config pull --output config.json", description: "Save config to a file" },
      { command: "clerk config schema", description: "Print full config schema" },
      {
        command: "clerk config schema --keys auth_email session",
        description: "Schema for specific top-level keys",
      },
      {
        command: "clerk config patch --file config.json",
        description: "Apply partial update from file",
      },
      {
        command: 'clerk config patch --json \'{"key":"value"}\'',
        description: "Inline JSON patch",
      },
      {
        command: "clerk config patch --file config.json --dry-run",
        description: "Preview without applying",
      },
      {
        command: "clerk config put --file config.json",
        description: "Replace entire config from file",
      },
      {
        command: "clerk config put --instance prod --file config.json",
        description: "Replace production config",
      },
    ]);

  config
    .command("pull")
    .description("Pull instance configuration from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .option("--output <file>", "Write config to a file instead of stdout")
    .option("--json", "Output JSON instead of the default YAML")
    .option(
      "--keys <keys...>",
      "Top-level config keys to retrieve, separated by spaces or commas (e.g. auth_email session)",
    )
    .setExamples([
      { command: "clerk config pull", description: "Print dev config (YAML) to stdout" },
      { command: "clerk config pull --instance prod", description: "Pull production config" },
      { command: "clerk config pull --output config.yaml", description: "Save config to a file" },
      { command: "clerk config pull --json", description: "Print config as JSON" },
    ])
    .action(configPull);

  config
    .command("schema")
    .description("Pull instance config schema from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write schema to a file instead of stdout")
    .option(
      "--keys <keys...>",
      "Top-level schema sections to retrieve, separated by spaces or commas (e.g. auth_email session)",
    )
    .setExamples([
      { command: "clerk config schema", description: "Print full config schema" },
      {
        command: "clerk config schema --keys auth_email session",
        description: "Schema for specific top-level keys",
      },
      { command: "clerk config schema --output schema.json", description: "Save schema to a file" },
    ])
    .action(configSchema);

  config
    .command("patch")
    .description("Partially update instance configuration (PATCH)")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
    .option(
      "--destructive",
      "Allow destructive changes that delete resources (e.g. session templates, custom OAuth providers) rather than just resetting config to defaults",
    )
    .setExamples([
      {
        command: "clerk config patch --file config.json",
        description: "Apply partial update from file",
      },
      {
        command: 'clerk config patch --json \'{"key":"value"}\'',
        description: "Inline JSON patch",
      },
      {
        command: "clerk config patch --file config.json --dry-run",
        description: "Preview without applying",
      },
      {
        command: "clerk config patch --instance prod --file config.json",
        description: "Patch production config",
      },
    ])
    .action(configPatch);

  config
    .command("put")
    .description("Replace entire instance configuration (PUT)")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
    .option(
      "--destructive",
      "Allow destructive changes that delete resources (e.g. session templates, custom OAuth providers) rather than just resetting config to defaults",
    )
    .setExamples([
      {
        command: "clerk config put --file config.json",
        description: "Replace entire config from file",
      },
      {
        command: "clerk config put --file config.json --dry-run",
        description: "Preview the replacement",
      },
      {
        command: "clerk config put --instance prod --file config.json",
        description: "Replace production config",
      },
      {
        command: "clerk config put --file config.json --yes",
        description: "Skip confirmation prompt",
      },
    ])
    .action(configPut);
}
