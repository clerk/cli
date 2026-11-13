/**
 * `clerk logs --help` is how an agent learns the command: the description
 * states the output shapes, and the examples walk the discovery flow. These
 * tests pin that text, check every example (in the help and in the README)
 * against the real command tree, and keep the README's discovery flow equal to
 * the help's.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { createProgram } from "../../cli-program.ts";

const README = await Bun.file(new URL("./README.md", import.meta.url)).text();

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_PATTERN, "");

// Set at load, not in a hook: the example tables below are built from the help
// at module scope, before any hook runs.
const saved = process.env.CLERK_EXPERIMENTAL;
process.env.CLERK_EXPERIMENTAL = "logs";
afterAll(() => {
  if (saved === undefined) delete process.env.CLERK_EXPERIMENTAL;
  else process.env.CLERK_EXPERIMENTAL = saved;
});

/** The `logs` command, or one of its subcommands, rendered at 80 columns. */
function logsCommand(...path: string[]): Command {
  const program = createProgram() as Command;
  let command = program.commands.find((candidate) => candidate.name() === "logs")!;
  for (const name of path) {
    command = command.commands.find((candidate) => candidate.name() === name)!;
  }
  command.configureOutput({ getOutHelpWidth: () => 80 });
  return command;
}

function helpOf(...path: string[]): string {
  return stripAnsi(logsCommand(...path).helpInformation());
}

/** The commands of a help screen's Examples section, without the `$ `. */
function helpExamples(help: string): string[] {
  const section = help.split("Examples:\n")[1] ?? "";
  return [...section.matchAll(/^ {2}\$ (.+?)(?: {2,}.*)?$/gm)].map((match) => match[1]!.trim());
}

/** Every `clerk logs …` line of the README's fenced `sh` blocks, minus comments. */
function readmeCommands(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((match) => match[1]!);
  return blocks.flatMap((block) =>
    block
      .split("\n")
      .map((line) => line.split(" #")[0]!.trim())
      .filter((line) => line.startsWith("clerk logs")),
  );
}

/** The commands of the README's discovery flow block. */
function readmeDiscoveryFlow(markdown: string): string[] {
  const section = markdown.split("## Discovery flow\n")[1]?.split("\n## ")[0] ?? "";
  return readmeCommands(section);
}

/** Walks as deep as the tree allows; the first flag or positional stops it. */
function resolve(tokens: string[]): { command: Command; rest: string[] } {
  let command = createProgram() as Command;
  let index = 0;
  for (; index < tokens.length; index++) {
    const child = command.commands.find((candidate) => candidate.name() === tokens[index]);
    if (!child) break;
    command = child;
  }
  return { command, rest: tokens.slice(index) };
}

/** The flags a command accepts, including those of its default subcommand. */
function flagsOf(command: Command): string[] {
  const own = command.options.flatMap(
    (option) => [option.short, option.long].filter(Boolean) as string[],
  );
  const defaultChild = command.commands.find(
    // Commander records the default subcommand on the parent, not the child.
    (child) => child.name() === (command as any)._defaultCommandName,
  );
  return defaultChild ? [...own, ...flagsOf(defaultChild)] : own;
}

/** The words of an example after `clerk`. */
function words(example: string): string[] {
  return example.split(/\s+/).slice(1);
}

describe("clerk logs --help", () => {
  test("teaches the output shapes and the discovery flow", () => {
    expect(helpOf()).toBe(
      [
        "Usage: clerk logs [options] [command]",
        "",
        "Read your instance's Application Logs.",
        "",
        "`list` is the default subcommand, so `clerk logs` alone lists the newest logs",
        "and takes every `list` flag. Start with `clerk logs schema` to find the event",
        "types and the payload fields `--type`, `--payload-filter` and `--fields` take.",
        "",
        "With --json (implied in agent mode), list and get print `{ data, cursor }`:",
        "`data` holds the logs as the Backend API returns them, and `cursor.next` is what",
        "to pass to --cursor for the next page (null when there are none). With --follow",
        "the output is NDJSON instead, one log per line. schema prints the API's schema",
        "objects as-is. Logs go back as far as your plan's log retention;",
        "`cursor.retention_limit_reached` says a list reached it.",
        "",
        "Options:",
        "  --app <id>          Application ID to target (works from any directory)",
        "  -h, --help          Display help for command",
        "  --instance <id>     Instance to target (dev, prod, or a full instance ID)",
        "  --secret-key <key>  Backend API secret key to use",
        "",
        "Commands:",
        "  get     [options] [id]          Show the logs of a log group (a sign-in or",
        "                                  sign-up), oldest first",
        "  help    [command]               Display help for command",
        "  list    [options]               List logs, newest first, or follow new ones",
        "                                  with --follow",
        "  schema  [options] [event-type]  List every log event type, or show the payload",
        "                                  fields of one",
        "",
        "Examples:",
        "  $ clerk logs schema --json                                                            Every event type and its payload fields",
        "  $ clerk logs schema user.created --json                                               The payload fields of one event type",
        "  $ clerk logs --type user.created --payload-filter user_id=user_123 --since 1h --json  The last hour's logs of that type with a matching field",
        "  $ clerk logs --grouped --status failed --since 1h --json                              Failed sign-in and sign-up flows, one item each",
        "  $ clerk logs get sia_123 --json                                                       The logs of one sign-in (sua_... for a sign-up)",
        "  $ clerk logs --follow --json                                                          Stream new logs as NDJSON, one per line",
        "  $ clerk logs --cursor <cursor> --json                                                 The next page, from a previous cursor.next",
        "",
      ].join("\n"),
    );
  });

  test("keeps the one-line summary for the root help table", () => {
    expect(logsCommand().summary()).toBe("Read your instance's Application Logs");
  });

  test.each([["list"], ["get"], ["schema"]])(
    "clerk logs %s --help shows --json examples",
    (name) => {
      expect(helpExamples(helpOf(name)).some((example) => example.endsWith("--json"))).toBe(true);
    },
  );
});

const HELP_EXAMPLES: [string, string][] = [[], ["list"], ["get"], ["schema"]].flatMap((path) =>
  helpExamples(helpOf(...path)).map(
    (example) => [`clerk logs ${path.join(" ")}`.trim(), example] as [string, string],
  ),
);

const README_EXAMPLES = readmeCommands(README);

describe("clerk logs examples", () => {
  // Guards the extractors: a regex that matched nothing would pass vacuously.
  test("finds the examples", () => {
    expect(HELP_EXAMPLES.length).toBeGreaterThan(25);
    expect(README_EXAMPLES.length).toBeGreaterThan(25);
  });

  test.each([...HELP_EXAMPLES.map(([, example]) => example), ...README_EXAMPLES])(
    "`%s` uses only flags the command accepts",
    (example) => {
      const { command, rest } = resolve(words(example));
      expect(command.name()).not.toBe("clerk");
      const flags = rest.filter((token) => token.startsWith("--")).map((t) => t.split("=")[0]!);
      expect(flags.filter((flag) => !flagsOf(command).includes(flag))).toEqual([]);
      const firstFlag = rest.findIndex((token) => token.startsWith("-"));
      const positionals = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
      expect(positionals.length).toBeLessThanOrEqual(command.registeredArguments.length);
    },
  );

  test("the README's discovery flow is the one clerk logs --help shows", () => {
    expect(readmeDiscoveryFlow(README)).toEqual(helpExamples(helpOf()));
  });
});
