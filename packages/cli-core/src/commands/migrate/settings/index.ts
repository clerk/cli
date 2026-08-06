import { createArgument } from "@commander-js/extra-typings";
import type { Command } from "@commander-js/extra-typings";
import { clear } from "./clear.ts";
import { list } from "./list.ts";
import { SETTING_NAMES } from "./registry.ts";
import { set } from "./set.ts";

const settings = { clear, list, set };

/**
 * Registers `settings list|set|clear` under the `migrate` group.
 *
 * Noun-verb like every other group in the tree, and listing is the default
 * because it is the read-only one — a bare `clerk migrate settings` should show,
 * never change.
 */
export function registerMigrateSettings(
  migrateCommand: Command<[], Record<string, unknown>>,
): void {
  const settingsCommand = migrateCommand
    .command("settings")
    .description("Inspect and change this project's saved migration settings")
    .setExamples([
      {
        command: "clerk migrate settings",
        description: "Show every setting and where it resolves from",
      },
      {
        command: "clerk migrate settings set firebase-signer-key abc123",
        description: "Save a credential to the gitignored .env.clerk-migrate",
      },
      { command: "clerk migrate settings clear -y", description: "Forget this project's settings" },
    ]);

  settingsCommand
    .command("list", { isDefault: true })
    .description("Show each setting, its value and which source supplied it")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk migrate settings list", description: "Credentials shown redacted" },
      { command: "clerk migrate settings list --json", description: "Machine-readable listing" },
    ])
    .action((_opts, cmd) =>
      settings.list(cmd.optsWithGlobals() as Parameters<typeof settings.list>[0]),
    );

  settingsCommand
    .command("set")
    .description("Set one setting for this project")
    .addArgument(createArgument("<name>", "Setting to change").choices(SETTING_NAMES))
    .addArgument(createArgument("<value>", "New value"))
    .setExamples([
      {
        command: "clerk migrate settings set transformer firebase",
        description: "Remember the source platform",
      },
      {
        command: "clerk migrate settings set firebase-signer-key abc123",
        description: "Write a credential to .env.clerk-migrate",
      },
    ])
    .action((name, value) => settings.set(name, value));

  settingsCommand
    .command("clear")
    .description("Forget the saved settings and remove the saved credentials")
    .option("-y, --yes", "Skip the confirmation prompt")
    .setExamples([
      { command: "clerk migrate settings clear", description: "Clear after confirming" },
      { command: "clerk migrate settings clear -y", description: "Clear without prompting" },
    ])
    .action((_opts, cmd) =>
      settings.clear(cmd.optsWithGlobals() as Parameters<typeof settings.clear>[0]),
    );
}
