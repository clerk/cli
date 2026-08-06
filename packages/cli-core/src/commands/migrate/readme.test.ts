/**
 * Keeps README.md and the command tree honest about each other.
 *
 * This README documents six export platforms, six transformers and three log
 * subcommands across ~600 lines. Checking it by eye at review time does not
 * scale, and a doc that names a flag the binary rejects is worse than no doc:
 * the reader trusts it and gets a usage error.
 *
 * Both directions are checked — every example must resolve, and every flag must
 * be written down — so neither renaming a flag nor adding one passes silently.
 */

import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { createProgram } from "../../cli-program.ts";

const README = await Bun.file(new URL("./README.md", import.meta.url)).text();

/** Fenced blocks only, so prose that merely mentions a flag is not parsed. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].map((match) => match[1] ?? "");
}

/**
 * Every `clerk migrate …` invocation the README puts in front of a reader, from
 * fenced blocks and inline backticks alike — both get copied.
 */
function documentedCommands(markdown: string): string[] {
  const found = new Set<string>();

  for (const block of fencedBlocks(markdown)) {
    // Line continuations first: the Firebase example spans three lines.
    for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) {
      const start = line.indexOf("clerk migrate");
      // A command never contains a backtick or a `#`; the sample error output
      // that quotes `clerk migrate` mid-sentence does.
      if (start !== -1) found.add(line.slice(start).split(/[`#]/)[0]!.trim());
    }
  }

  for (const match of markdown.matchAll(/`(clerk migrate[^`]*)`/g)) {
    found.add(match[1]!.trim());
  }

  return [...found];
}

/** Walks as deep as the tree allows; the first flag or positional stops it. */
function resolve(tokens: string[]): { command: Command; rest: string[] } {
  let command = createProgram() as Command;
  let index = 0;
  for (; index < tokens.length; index++) {
    const child = command.commands.find(
      (candidate) =>
        candidate.name() === tokens[index] || candidate.aliases().includes(tokens[index]!),
    );
    if (!child) break;
    command = child;
  }
  return { command, rest: tokens.slice(index) };
}

function flagsOf(command: Command): string[] {
  return command.options.flatMap(
    (option) => [option.short, option.long].filter(Boolean) as string[],
  );
}

/** Every command under `migrate`, so no subcommand escapes the flag sweep. */
function migrateTree(): { path: string; command: Command }[] {
  const collected: { path: string; command: Command }[] = [];
  const visit = (command: Command, path: string) => {
    collected.push({ path, command });
    for (const child of command.commands) {
      if (child.name() !== "help") visit(child, `${path} ${child.name()}`);
    }
  };
  visit(resolve(["migrate"]).command, "migrate");
  return collected;
}

const EXAMPLES = documentedCommands(README);

/** One case per (example, flag) pair, so a failure names the exact flag. */
const FLAG_USES: [string, string][] = EXAMPLES.flatMap((example) =>
  example
    .split(/\s+/)
    .filter((token) => token.startsWith("-"))
    .map((token) => [example, token.split("=")[0]!] as [string, string]),
);

describe("migrate README", () => {
  // Guards the extractor: a regex that silently matched nothing would make
  // every check below pass vacuously.
  test("finds the documented examples", () => {
    expect(EXAMPLES.length).toBeGreaterThan(20);
    expect(FLAG_USES.length).toBeGreaterThan(20);
  });

  test.each(EXAMPLES)("`%s` resolves to a real command", (example) => {
    const tokens = example.split(/\s+/).slice(1);
    const { command, rest } = resolve(tokens);
    const firstFlag = rest.findIndex((token) => token.startsWith("-"));
    const positionals = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
    // Leftover words before any flag are positionals — only some commands take
    // them, and a subcommand that does not exist lands here too.
    if (positionals.length > 0) expect(command.registeredArguments.length).toBeGreaterThan(0);
    // A parent means at least `migrate` resolved. Checking the name instead
    // would be wrong: `migrate export clerk` is itself named `clerk`.
    expect(command.parent).not.toBeNull();
  });

  test.each(FLAG_USES)("`%s` uses %s, which the command accepts", (example, flag) => {
    const { command } = resolve(example.split(/\s+/).slice(1));
    expect(flagsOf(command)).toContain(flag);
  });

  test.each(migrateTree())("$path documents every flag it accepts", ({ command }) => {
    const undocumented = flagsOf(command).filter(
      (flag) => flag.startsWith("--") && flag !== "--help" && !README.includes(flag),
    );
    expect(undocumented).toEqual([]);
  });
});
