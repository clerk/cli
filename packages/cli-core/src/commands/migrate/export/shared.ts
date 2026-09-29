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
import { throwUsageError } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { text } from "../../../lib/prompts.ts";
import { isHuman } from "../../../mode.ts";
import { isAssumeYes } from "../lib/assume-yes.ts";

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
 * `--output` is an answer already given, and agent mode has nobody to ask, so
 * it takes the proposal.
 *
 * `-y` is neither: somebody is there, and they said not to ask. It fails
 * instead of defaulting, because this is the one prompt whose default cannot
 * be undone by running the command again — a file written to a path nobody
 * chose has to be found and moved, and a second run writes a second copy.
 * Silencing that question is what `--output` is for, so the error hands over
 * the exact line, proposed path and all. (The log-directory question does take
 * its default under `-y`: `./logs` is where the reader would look anyway, and
 * nothing is saved.)
 */
export async function resolveOutputPath(platform: string, output?: string): Promise<string> {
  if (output) return output;

  const proposed = defaultOutputPath(platform);
  // Ordered so agent mode keeps defaulting even when it also passes `-y`:
  // there was never a prompt on that path to suppress.
  if (!isHuman()) return proposed;

  if (isAssumeYes()) {
    throwUsageError(
      `\`clerk migrate export ${platform}\` needs an export location and will not prompt for one with -y.\nPass --output, then run it again.`,
      undefined,
      undefined,
      [
        {
          command: `clerk migrate export ${platform} -y --output ${proposed}`,
          description: "Re-run with the proposed path",
        },
      ],
    );
  }

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

/**
 * An extra block printed under the coverage table.
 *
 * For a breakdown that is not "how many users have this field" — WorkOS's
 * OAuth providers, where one user can appear in two rows and the denominator
 * is not the user count. Folding that into the coverage table would put rows
 * of two different kinds under one heading.
 */
export type ExportSection = { title: string; rows: string[] };

export type ExportSummary = {
  platform: string;
  userCount: number;
  outputPath: string;
  coverage: CoverageField[];
  /** Extra blocks, printed under the coverage table in order. */
  sections?: ExportSection[];
  /** The transformer that reads this file, for the "what next" line. */
  transformerKey: string;
};

/**
 * Reports the coverage table and the import command that reads the file.
 *
 * The command prints through `log.info`, alongside the coverage table, rather
 * than being handed back for `setNextSteps`. The gutter's next-steps outro is
 * human-only — `withGutter` and `printNextSteps` both return early for an agent
 * or a non-TTY — and this is the one line that says what to do with the file
 * just written. An agent that cannot see it has to guess the invocation.
 */
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

  for (const section of summary.sections ?? []) {
    log.blank();
    log.info(section.title);
    for (const row of section.rows) log.info(row);
  }

  log.blank();
  log.success(
    `Exported ${summary.userCount} user${summary.userCount === 1 ? "" : "s"} to ${summary.outputPath}`,
  );

  log.blank();
  for (const line of formatImportCommand(
    summary.transformerKey,
    relativeIfInside(summary.outputPath),
  )) {
    log.info(line);
  }
}

/**
 * The import command for the file just written, and what it will target.
 *
 * One command rather than a development and a production variant, because
 * there is no flag whose absence means "development": the key decides, through
 * `--secret-key`, `--app`, `CLERK_SECRET_KEY`, the keyless project and the
 * linked profile in that order. A line labelled "development" would be wrong
 * for anyone holding `CLERK_SECRET_KEY=sk_live_…`, which is the reader who can
 * least afford it. So the note names what picks the instance instead.
 *
 * `-y` is carried across from this export rather than always printed: on
 * import it also waves through the development-instance user-limit warning, so
 * it is not a flag to suggest to someone who never asked for it.
 */
export function formatImportCommand(transformerKey: string, file: string): string[] {
  const yes = isAssumeYes() ? "-y " : "";
  return [
    "Import them with:",
    dim(`  clerk migrate import ${yes}--transformer ${transformerKey} --file ${file}`),
    "",
    dim("  Imports into whichever instance the resolved secret key belongs to."),
    dim("  For production, add `--instance prod` or use a production secret key."),
    ...(isAssumeYes() ? [] : [dim("  Add `-y` to skip the import confirmation prompt.")]),
  ];
}

/** Shortens a path for display when it sits under the working directory. */
function relativeIfInside(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith("..") ? absolute : relative;
}
