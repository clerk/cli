/**
 * `clerk migrate sources [source]` — which platforms an import can read, and
 * what each one brings across.
 *
 * A compiled binary's users have no source tree to read the mappings in, so
 * this is where they are shown. `sources` alone lists every source with its
 * passwords, MFA and metadata at a glance. `sources <source>` shows one in
 * full: what each field becomes, how to export from it, and its caveats.
 */

import { bold, cyan, dim, green, red, yellow } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { exportPlatforms } from "../export/registry.ts";
import type { Carry, CarryLevel, SourceEntry } from "../types.ts";
import { ACCOUNT_LINKING_NOTE, resolveSource, sources as builtIns } from "./registry.ts";

export type SourcesOptions = {
  json?: boolean;
};

const KINDS = [
  ["passwords", "Passwords"],
  ["mfa", "MFA"],
  ["metadata", "Metadata"],
] as const;

/**
 * Capped, not just measured: a description that rewrapped differently on every
 * terminal makes two runs of the same command look like different output. 80 is
 * the same width `--help` lays itself out at.
 */
const MAX_WIDTH = 80;

function outputWidth(): number {
  return Math.min(process.stderr.columns || MAX_WIDTH, MAX_WIDTH);
}

/**
 * A run of non-space characters, except that a backticked span counts as one
 * character run even when it contains spaces. Keeps `SELECT a, b FROM users`
 * whole: `log.info` pairs backticks per line, so a span broken across two lines
 * leaves an unmatched backtick on each and colours the wrong half of both.
 */
const WORD = /(?:`[^`]*`|\S)+/g;

/**
 * Wraps on whitespace. Safe to measure raw because the backtick spans
 * `log.info` highlights keep their backticks — the colour it adds is invisible
 * to width, and nothing here is coloured before wrapping.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.match(WORD) ?? []) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  return lines;
}

function levelMark(level: CarryLevel): string {
  if (level === "yes") return green("yes");
  if (level === "partial") return yellow("partial");
  return red("no");
}

/** The command that writes a file this source reads, when there is one. */
function exportCommand(entry: SourceEntry): string | undefined {
  const platform = exportPlatforms.find((candidate) => candidate.sourceKey === entry.key);
  return platform ? `clerk migrate export ${platform.key}` : undefined;
}

function toJson(entry: SourceEntry, custom?: string) {
  return {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    ...(custom ? { path: custom } : {}),
    carries: entry.carries,
    export_command: exportCommand(entry) ?? null,
    fields: entry.transformer,
    caveats: entry.caveats ?? [],
  };
}

function printList(width: number): void {
  for (const line of wrapText(
    "A source maps one platform's export onto the fields Clerk imports. A file from " +
      "`clerk migrate export` names its own; anything else takes `--source <key|path>`.",
    width,
  )) {
    log.info(line);
  }
  log.blank();

  const keyWidth = Math.max(...builtIns.map((entry) => entry.key.length)) + 2;
  log.info(
    bold(
      `${"SOURCE".padEnd(keyWidth)}${"PASSWORDS".padEnd(11)}${"MFA".padEnd(9)}${"METADATA".padEnd(10)}`,
    ),
  );
  for (const entry of builtIns) {
    const cell = (carry: Carry, pad: number) =>
      levelMark(carry.level) + " ".repeat(Math.max(1, pad - carry.level.length));
    log.info(
      `${cyan(entry.key.padEnd(keyWidth))}${cell(entry.carries.passwords, 11)}` +
        `${cell(entry.carries.mfa, 9)}${levelMark(entry.carries.metadata.level)}`,
    );
  }

  log.blank();
  for (const line of wrapText(ACCOUNT_LINKING_NOTE, width)) log.info(dim(line));
  log.blank();
  log.info("Run `clerk migrate sources <source>` for what each field becomes.");
  log.info("Migrating from something else? Write a source and pass --source ./my-source.ts.");
}

function printDetail(entry: SourceEntry, width: number, custom?: string): void {
  log.info(`${cyan(bold(entry.key))}  ${entry.label}${custom ? dim(` (custom — ${custom})`) : ""}`);
  for (const line of wrapText(entry.description, width)) log.info(line);

  const command = exportCommand(entry);
  if (command) {
    log.blank();
    log.info(`${bold("Export with")}  \`${command}\``);
  }

  log.blank();
  log.info(bold("What comes across"));
  for (const [kind, label] of KINDS) {
    const carry = entry.carries[kind];
    log.info(`  ${label.padEnd(10)}${levelMark(carry.level)}`);
    for (const line of wrapText(carry.note, width - 4)) log.info(`    ${dim(line)}`);
  }

  const fields = Object.entries(entry.transformer);
  const fromWidth = Math.max(...fields.map(([from]) => from.length)) + 2;
  log.blank();
  log.info(bold("Where each field lands"));
  for (const [from, to] of fields) log.info(`  ${from.padEnd(fromWidth)}→ ${to}`);
  if (entry.defaults) {
    for (const [field, value] of Object.entries(entry.defaults)) {
      log.info(dim(`  ${field} is always ${JSON.stringify(value)}`));
    }
  }

  if (entry.caveats?.length) {
    log.blank();
    log.info(bold("Caveats"));
    for (const caveat of entry.caveats) {
      const [first, ...rest] = wrapText(caveat, width - 4);
      log.info(`  - ${first ?? ""}`);
      for (const line of rest) log.info(`    ${line}`);
    }
  }

  log.blank();
  for (const line of wrapText(ACCOUNT_LINKING_NOTE, width)) log.info(dim(line));
}

export async function list(key: string | undefined, options: SourcesOptions = {}): Promise<void> {
  const width = outputWidth();

  if (key === undefined) {
    if (options.json) {
      log.data(
        JSON.stringify(
          {
            sources: builtIns.map((entry) => toJson(entry)),
            account_linking: ACCOUNT_LINKING_NOTE,
          },
          null,
          2,
        ),
      );
      return;
    }
    printList(width);
    return;
  }

  // No gutter: this reads a static registry, it does not run anything.
  const resolved = await resolveSource(key);
  if (options.json) {
    log.data(
      JSON.stringify(
        { ...toJson(resolved.entry, resolved.path), account_linking: ACCOUNT_LINKING_NOTE },
        null,
        2,
      ),
    );
    return;
  }
  printDetail(resolved.entry, width, resolved.path ? key : undefined);
}
