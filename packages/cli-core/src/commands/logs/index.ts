import type { Program } from "../../cli-program.ts";
import { isExperimentEnabled, requireExperiment } from "../../lib/experimental.ts";
import { parseIntegerOption } from "../../lib/option-parsers.ts";
import { list } from "./list.ts";

const logs = { list };

export function registerLogs(program: Program, env: NodeJS.ProcessEnv = process.env): void {
  // Experimental until `clerk logs` is ready to ship (Linear project
  // "Logs: $ clerk logs subcommand"); the gate comes off then. Same stub as
  // `clerk migrate`: hidden, no subcommands for completion to walk, and it
  // accepts anything so every invocation reaches the refusal.
  if (!isExperimentEnabled("logs", env)) {
    const stub = program
      .command("logs", { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument("[args...]")
      .action(() => requireExperiment("logs", env));
    // `clerk help logs` renders help without running the action.
    stub.helpInformation = () => {
      requireExperiment("logs", env);
      return "";
    };
    return;
  }

  const logsCommand = program
    .command("logs")
    .description("Read your instance's Application Logs")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      { command: "clerk logs", description: "List the newest logs" },
      { command: "clerk logs --instance prod --json", description: "Production logs as JSON" },
    ]);

  logsCommand
    .command("list", { isDefault: true })
    .description("List logs, newest first")
    .option("--json", "Output as JSON")
    .option("--limit <number>", "Maximum logs to return (1-500, default 50)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 500 }),
    )
    .option("--cursor <cursor>", "Continue from the cursor a previous run printed")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      { command: "clerk logs list", description: "List the 50 newest logs" },
      { command: "clerk logs list --limit 200", description: "List the 200 newest logs" },
      {
        command: "clerk logs list --cursor <cursor>",
        description: "Continue where a previous run stopped",
      },
      {
        command: "clerk logs list --app app_123 --instance prod --json",
        description: "Production logs of another application as JSON",
      },
    ])
    .action(async (_opts, cmd) =>
      logs.list(cmd.optsWithGlobals() as Parameters<typeof logs.list>[0]),
    );
}
