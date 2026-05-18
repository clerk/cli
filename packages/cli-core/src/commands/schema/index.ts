import type { Program } from "../../cli-program.ts";
import { log } from "../../lib/log.ts";
import { getCurrentVersion } from "../../lib/update-check.ts";

// Commander's recursive `parent` chain is typed with concrete generic
// parameters that don't unify across heterogeneous subcommands. We only
// need the introspection surface (name/aliases/description/registeredArguments
// /options/commands), so type the walker against a structural minimum.
interface ArgumentLike {
  name(): string;
  description?: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: unknown;
  argChoices?: readonly string[];
}

interface OptionLike {
  flags: string;
  description?: string;
  defaultValue?: unknown;
  required: boolean;
  optional: boolean;
  argChoices?: readonly string[];
  variadic: boolean;
  negate: boolean;
  hidden: boolean;
}

interface CommandLike {
  name(): string;
  aliases(): string[];
  description(): string;
  registeredArguments: readonly ArgumentLike[];
  options: readonly OptionLike[];
  commands: readonly CommandLike[];
  parent?: CommandLike | null;
}

interface SchemaOption {
  flags: string;
  description: string;
  defaultValue?: unknown;
  required: boolean;
  optional: boolean;
  choices?: readonly string[];
  variadic: boolean;
  negate: boolean;
  hidden: boolean;
}

interface SchemaArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: unknown;
  choices?: readonly string[];
}

interface SchemaCommand {
  name: string;
  aliases: string[];
  description: string;
  hidden: boolean;
  arguments: SchemaArgument[];
  options: SchemaOption[];
  subcommands: SchemaCommand[];
}

interface SchemaDocument {
  cli: string;
  version: string;
  schemaVersion: 1;
  command: SchemaCommand;
}

function describeCommand(cmd: CommandLike): SchemaCommand {
  return {
    name: cmd.name(),
    aliases: cmd.aliases(),
    description: cmd.description(),
    hidden: Boolean((cmd as unknown as { _hidden?: boolean })._hidden),
    arguments: cmd.registeredArguments.map((arg) => ({
      name: arg.name(),
      description: arg.description ?? "",
      required: arg.required,
      variadic: arg.variadic,
      defaultValue: arg.defaultValue,
      choices: arg.argChoices,
    })),
    options: cmd.options.map((opt) => ({
      flags: opt.flags,
      description: opt.description ?? "",
      defaultValue: opt.defaultValue,
      required: opt.required,
      optional: opt.optional,
      choices: opt.argChoices,
      variadic: opt.variadic,
      negate: opt.negate,
      hidden: opt.hidden,
    })),
    subcommands: cmd.commands.filter((sub) => sub.name() !== "help").map(describeCommand),
  };
}

function schema(_opts: unknown, cmd: { parent?: CommandLike | null }) {
  // Walk from the program root regardless of where `schema` is mounted.
  let root: CommandLike | null | undefined = cmd.parent;
  while (root?.parent) root = root.parent;
  if (!root) {
    throw new Error("Unable to resolve root command for schema dump");
  }
  const doc: SchemaDocument = {
    cli: "clerk",
    version: getCurrentVersion(),
    schemaVersion: 1,
    command: describeCommand(root),
  };
  log.data(JSON.stringify(doc));
}

export function registerSchema(program: Program): void {
  program
    .command("schema")
    .description("Print the full CLI command tree as JSON (for agents and tooling)")
    .option("--json", "No-op for symmetry with other commands — `schema` always emits JSON.")
    .setExamples([
      { command: "clerk schema", description: "Dump command tree to stdout" },
      {
        command: "clerk schema | jq '.command.subcommands[].name'",
        description: "List every subcommand",
      },
    ])
    .action((opts, cmd) => schema(opts, cmd));
}
