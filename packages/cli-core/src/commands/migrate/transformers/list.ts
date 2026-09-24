/**
 * `clerk migrate transformers list` — which source platforms are available.
 *
 * New in the CLI. The standalone tool's interactive picker was the only place
 * these were listed, which was fine when the user had the source tree to grep.
 * A compiled binary's users have neither, so the list is a command.
 */

import { bold, cyan } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import type { TransformerRegistryEntry } from "../types.ts";
import { loadCustomTransformer } from "./load-custom.ts";
import { transformers } from "./registry.ts";

export type TransformersListOptions = {
  json?: boolean;
  transformerFile?: string;
};

type Listed = TransformerRegistryEntry & { builtIn: boolean; source?: string };

function toJson(entries: Listed[]) {
  return entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    description: entry.description,
    built_in: entry.builtIn,
    ...(entry.source ? { source: entry.source } : {}),
    maps_to_user_id:
      Object.entries(entry.transformer).find(([, target]) => target === "userId")?.[0] ?? null,
  }));
}

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

export async function list(options: TransformersListOptions = {}): Promise<void> {
  const entries: Listed[] = transformers.map((entry) => ({ ...entry, builtIn: true }));

  if (options.transformerFile) {
    const custom = await loadCustomTransformer(options.transformerFile);
    entries.push({ ...custom, builtIn: false, source: options.transformerFile });
  }

  if (options.json) {
    log.data(JSON.stringify(toJson(entries), null, 2));
    return;
  }

  const width = outputWidth();

  // No gutter: this reads a static registry, it does not run anything. The
  // frame belongs on `migrate import`, where there is progress to bracket.
  for (const line of wrapText(
    "A transformer maps one platform's export onto the fields Clerk imports. " +
      "Pass the one your export came from as `--transformer <key>`.",
    width,
  )) {
    log.info(line);
  }
  log.blank();

  log.info(bold("Transformers:"));
  for (const entry of entries) {
    const suffix = entry.builtIn ? "" : ` (custom — ${entry.source})`;
    log.info(`  ${cyan(bold(entry.key))}  ${entry.label}${suffix}`);
    for (const line of wrapText(entry.description, width - 4)) {
      log.info(`    ${line}`);
    }
    log.blank();
  }

  const custom = entries.length - transformers.length;
  log.info(
    `${transformers.length} built-in transformer${transformers.length === 1 ? "" : "s"}` +
      (custom > 0 ? ` plus ${custom} loaded from --transformer-file` : ""),
  );

  if (custom === 0) {
    log.info("Migrating from something else? Write a transformer and pass --transformer-file.");
  }
}
