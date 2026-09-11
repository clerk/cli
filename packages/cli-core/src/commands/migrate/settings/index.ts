import { createArgument, InvalidArgumentError } from "@commander-js/extra-typings";
import type { Command } from "@commander-js/extra-typings";
import { clear } from "./clear.ts";
import { list } from "./list.ts";
import { SETTING_NAMES, suggestSettingName } from "./registry.ts";
import { set } from "./set.ts";

const settings = { clear, list, set };

/**
 * The `<name>` argument both `set` and `clear` take.
 *
 * `.choices()` is what drives tab-completion and the help output's choice list,
 * but it is implemented as a `parseArg` that throws before the action runs — so
 * the friendlier "Unknown setting" errors inside `set.ts` and `clear.ts` are
 * unreachable from the CLI, and a one-character miss like `logs-dir` gets only
 * the full list back. Wrapping that parser keeps the completion metadata and
 * puts the near miss first, where a reader scanning eight names would not find
 * it.
 */
function settingNameArgument<S extends `<${string}>` | `[${string}]`>(
  spec: S,
  description: string,
) {
  const argument = createArgument(spec, description).choices(SETTING_NAMES);
  const rejectUnlessAllowed = argument.parseArg;

  // Whether the value is allowed stays Commander's question — asking it here
  // too would be a second copy of the rule, free to disagree with the first.
  // This only adds to the answer when the answer is no.
  argument.parseArg = <T>(value: string, previous: T): T => {
    try {
      return rejectUnlessAllowed?.(value, previous) as T;
    } catch (error) {
      const suggestion = suggestSettingName(value);
      if (!suggestion) throw error;
      throw new InvalidArgumentError(
        `Did you mean "${suggestion}"? Allowed choices are ${SETTING_NAMES.join(", ")}.`,
      );
    }
  };

  return argument;
}

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
      {
        command: "clerk migrate settings clear firebase-signer-key",
        description: "Forget one setting",
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
    .addArgument(settingNameArgument("<name>", "Setting to change"))
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
    .description("Forget one saved setting, or every setting and saved credential")
    .addArgument(settingNameArgument("[name]", "Setting to clear; omit to clear them all"))
    .option("-y, --yes", "Skip the confirmation prompt")
    .setExamples([
      { command: "clerk migrate settings clear", description: "Clear everything after confirming" },
      {
        command: "clerk migrate settings clear file",
        description: "Forget only the remembered export file",
      },
      { command: "clerk migrate settings clear -y", description: "Clear without prompting" },
    ])
    .action((name, _opts, cmd) =>
      settings.clear(cmd.optsWithGlobals() as Parameters<typeof settings.clear>[0], name),
    );
}
