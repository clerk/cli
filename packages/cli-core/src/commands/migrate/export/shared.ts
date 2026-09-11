/**
 * Shared plumbing for the export modules: where the file lands, and what the
 * user is told about it.
 *
 * Ported from the standalone migration-tool's `src/lib/export.ts`, with one
 * behavioural change: `--output` resolves against the **current working
 * directory**, the way every other path flag in this CLI does. The original
 * resolved a relative `--output` inside `exports/`, so `--output ./here.json`
 * silently wrote to `exports/here.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { dim, green, yellow } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { NEXT_STEPS } from "../../../lib/next-steps.ts";
import { text } from "../../../lib/prompts.ts";
import { isHuman } from "../../../mode.ts";

/**
 * `YYYYMMDD-HHmm`, local time — ISO 8601 basic format, minus seconds.
 *
 * Basic throughout rather than `2026-08-17-1954`, which mixes the extended
 * date form with the basic time form and leaves the trailing group looking
 * like a fourth date component. One separator, and it sorts lexically.
 *
 * Seconds are dropped on purpose. This lands in a filename people read off the
 * screen, type back and tab-complete, and two exports of the same platform
 * inside one minute is not an accident anyone has by surprise.
 *
 * Local rather than UTC because the only reader is the person who just ran the
 * command, deciding which of two files is the one they meant.
 */
export function outputStamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Where an export lands when `--output` is not given. */
export function defaultOutputPath(platform: string, now?: Date): string {
  return path.join("exports", `${platform}-export-${outputStamp(now)}.json`);
}

/**
 * Settles where the file lands, before the export runs.
 *
 * Asked up front rather than at write time so a long export can be left
 * unattended — coming back to a stalled prompt with every user held in memory
 * and nothing on disk is the worse half of that trade.
 *
 * One prompt, not a confirm followed by a path prompt: the proposed path is
 * prefilled, so Enter accepts it and typing replaces it.
 *
 * `--output` is an answer already given, and agent mode has nobody to ask.
 */
export async function resolveOutputPath(platform: string, output?: string): Promise<string> {
  if (output) return output;

  const proposed = defaultOutputPath(platform);
  if (!isHuman()) return proposed;

  const chosen = await text({
    message: "Save the export to:",
    default: proposed,
    validate: (value) => (value?.trim() ? undefined : "A path is required"),
  });
  return chosen.trim();
}

/**
 * Writes the export, creating any missing parent directories.
 *
 * @returns The absolute path written, for reporting.
 */
export function writeExportOutput(users: unknown[], outputFile: string): string {
  const resolved = path.resolve(process.cwd(), outputFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(users, null, 2));
  return resolved;
}

export type CoverageField = { label: string; count: number };

/**
 * How complete an export is, per field.
 *
 * ✓ every user, ! some, dim ✗ none. The point is to see *before* importing
 * that, say, only 3 of 400 users have a password — which changes what the
 * migration means.
 */
export function formatFieldCoverage(fields: CoverageField[], total: number): string[] {
  return fields.map(({ label, count }) => {
    const icon = count === total ? green("✓") : count > 0 ? yellow("!") : dim("✗");
    return `  ${icon} ${dim(`${count}/${total} ${label}`)}`;
  });
}

export type ExportSummary = {
  platform: string;
  userCount: number;
  outputPath: string;
  coverage: CoverageField[];
  /** The transformer that reads this file, for the "what next" line. */
  transformerKey: string;
};

/**
 * Reports the coverage table.
 *
 * @returns The next steps for the caller to hand to `setNextSteps`, so the
 *   suggested import command closes the gutter like every other command's.
 *   Empty when nothing was exported — there is nothing to import.
 */
export function reportExport(summary: ExportSummary): readonly string[] {
  log.blank();
  if (summary.userCount === 0) {
    log.warn(`No users found to export. Wrote an empty file to ${summary.outputPath}.`);
    return [];
  }

  log.info("Field coverage");
  for (const line of formatFieldCoverage(summary.coverage, summary.userCount)) {
    log.info(line);
  }

  log.blank();
  log.success(
    `Exported ${summary.userCount} user${summary.userCount === 1 ? "" : "s"} to ${summary.outputPath}`,
  );

  return NEXT_STEPS.MIGRATE_EXPORT(summary.transformerKey, relativeIfInside(summary.outputPath));
}

/** Shortens a path for display when it sits under the working directory. */
function relativeIfInside(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith("..") ? absolute : relative;
}
