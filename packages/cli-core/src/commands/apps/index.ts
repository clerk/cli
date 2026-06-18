import type { Program } from "../../cli-program.ts";
import { list } from "./list.ts";
import { create } from "./create.ts";

export function registerApps(program: Program): void {
  const apps = program.command("apps").description("Manage your Clerk applications");

  apps
    .command("list")
    .description("List your Clerk applications")
    .option(
      "--json",
      "Output as JSON. Fields: application_id, name, instances[] (instance_id, environment_type, publishable_key)",
    )
    .setExamples([
      { command: "clerk apps list", description: "List all applications" },
      { command: "clerk apps list --json", description: "Output as JSON" },
    ])
    .action(list);

  apps
    .command("create")
    .description("Create a new Clerk application (not idempotent by default — use --if-not-exists)")
    .argument("<name>", "Application name")
    .option(
      "--json",
      "Output as JSON. Fields: application_id, name, instances[] (instance_id, environment_type, publishable_key)",
    )
    .option(
      "--if-not-exists",
      "Make the operation idempotent: if an application with this name already exists, return it instead of creating a duplicate",
    )
    .setExamples([
      { command: 'clerk apps create "My App"', description: "Create a new application" },
      { command: 'clerk apps create "My App" --json', description: "Output as JSON" },
      {
        command: 'clerk apps create "My App" --if-not-exists',
        description: "Idempotent create — safe to re-run",
      },
    ])
    .action(create);
}
