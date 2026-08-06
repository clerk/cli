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

/** Where an export lands when `--output` is not given. */
export function defaultOutputPath(platform: string): string {
  return path.join("exports", `${platform}-export.json`);
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
 * ● every user, ○ some, dim ○ none. The point is to see *before* importing
 * that, say, only 3 of 400 users have a password — which changes what the
 * migration means.
 */
export function formatFieldCoverage(fields: CoverageField[], total: number): string[] {
  return fields.map(({ label, count }) => {
    const icon = count === total ? green("●") : count > 0 ? yellow("○") : dim("○");
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

/** Reports the coverage table and the exact command that consumes the file. */
export function reportExport(summary: ExportSummary): void {
  log.blank();
  if (summary.userCount === 0) {
    log.warn(`No users found to export. Wrote an empty file to ${summary.outputPath}.`);
    return;
  }

  log.info("Field coverage");
  for (const line of formatFieldCoverage(summary.coverage, summary.userCount)) {
    log.info(line);
  }

  log.blank();
  log.success(`Exported ${summary.userCount} user(s) to ${summary.outputPath}`);
  log.info(
    dim(
      `Next: clerk migrate run --transformer ${summary.transformerKey} --file ${relativeIfInside(summary.outputPath)}`,
    ),
  );
}

/** Shortens a path for display when it sits under the working directory. */
function relativeIfInside(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith("..") ? absolute : relative;
}
