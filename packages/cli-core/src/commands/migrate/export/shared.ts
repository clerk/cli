/**
 * Shared plumbing for the export modules: the run that records each user,
 * where the file lands, and what the user is told about it.
 *
 * Every export is a run. The file lands in that run's folder as
 * `export.json` unless `--output` names somewhere else, and `--output`
 * resolves against the **current working directory**, the way every other
 * path flag in this CLI does.
 */

import fs from "node:fs";
import path from "node:path";
import { dim, green, yellow } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { ENVELOPE_VERSION, type ExportEnvelope } from "../lib/export-file.ts";
import { ACCOUNT_LINKING_NOTE } from "../sources/registry.ts";
import {
  resolveRunsDir,
  sha256File,
  startRun,
  type Run,
  type RunRecord,
  type RunTarget,
} from "../lib/run-store.ts";
import type { FirebaseHashConfig } from "../types.ts";

/** What every export command takes on top of its own credentials. */
export type ExportCommonOptions = {
  /** Where to write the file, instead of the run folder. */
  output?: string;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
  json?: boolean;
};

/**
 * Starts the export run that records each user as it is exported.
 *
 * Started once the users are in hand, so a rejected credential leaves no run
 * behind.
 */
export async function startExportRun(
  options: ExportCommonOptions,
  target: RunTarget,
): Promise<Run> {
  const runsDir = await resolveRunsDir(options.runsDir, { write: true });
  return startRun(runsDir, { kind: "export", target, source: target.platform });
}

/** Where the file lands: `--output`, or `export.json` in the run folder. */
export function exportPath(run: Run, output: string | undefined): string {
  return output ? path.resolve(process.cwd(), output) : path.join(run.dir, "export.json");
}

/**
 * Writes the envelope, creating any missing parent directories.
 *
 * @returns The absolute path written.
 */
export function writeExportFile(file: string, envelope: ExportEnvelope): string {
  // Password hashes, PII and a Firebase signer key: owner-only.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  return file;
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

/**
 * The import command for an export run, and what it will target.
 *
 * One command rather than a development and a production variant, because
 * there is no flag whose absence means "development": the key decides, through
 * `--secret-key`, `--app`, `CLERK_SECRET_KEY`, the keyless project and the
 * linked profile in that order. A line labelled "development" would be wrong
 * for anyone holding `CLERK_SECRET_KEY=sk_live_…`, which is the reader who can
 * least afford it. So the note names what picks the instance instead.
 */
export function formatImportCommand(runId: string): string[] {
  return [
    "Import them with:",
    dim(`  clerk migrate import ${runId}`),
    "",
    dim("  Imports into whichever instance the resolved secret key belongs to."),
    dim("  For production, add `--instance prod` or use a production secret key."),
  ];
}

export type FinishExportInput = {
  run: Run;
  options: ExportCommonOptions;
  users: Record<string, unknown>[];
  coverage: CoverageField[];
  /** Extra blocks, printed under the coverage table in order. */
  sections?: ExportSection[];
  /** Firebase's hash parameters, carried to the import in the envelope. */
  firebase?: FirebaseHashConfig;
  /** The platform stopped short of every user; `--json` says so. */
  truncated?: boolean;
};

export type FinishedExport = { record: RunRecord; outputPath: string };

/**
 * Writes the envelope, finishes the run, and reports it.
 *
 * The import command prints through `log.info` rather than the gutter's
 * next-steps outro, which is human-only: this is the one line that says what
 * to do with the file, and an agent that cannot see it has to guess. `--json`
 * returns the same facts on stdout instead.
 */
export function finishExport(input: FinishExportInput): FinishedExport {
  const { run, options, users, coverage } = input;
  const platform = run.record.target.platform ?? run.record.source ?? "";
  const outputPath = writeExportFile(exportPath(run, options.output), {
    clerkMigrate: ENVELOPE_VERSION,
    source: run.record.source ?? platform,
    exportedAt: new Date().toISOString(),
    runId: run.record.id,
    ...(input.firebase ? { firebase: input.firebase } : {}),
    users,
  });
  run.update({ file: { path: outputPath, sha256: sha256File(outputPath) } });
  const record = run.finish();
  const next = `clerk migrate import ${record.id}`;

  if (options.json) {
    log.data(
      JSON.stringify(
        {
          target: record.target,
          run: record,
          output: outputPath,
          users: users.length,
          coverage,
          ...(input.sections?.length ? { sections: input.sections } : {}),
          ...(input.truncated ? { truncated: true } : {}),
          next,
        },
        null,
        2,
      ),
    );
    return { record, outputPath };
  }

  log.blank();
  if (users.length === 0) {
    log.warn(`No users found to export. Wrote an empty file to ${outputPath}.`);
    log.info(dim(`Run ${record.id}`));
    return { record, outputPath };
  }

  log.info("Field coverage");
  for (const line of formatFieldCoverage(coverage, users.length)) log.info(line);

  for (const section of input.sections ?? []) {
    log.blank();
    log.info(section.title);
    for (const row of section.rows) log.info(row);
  }

  log.blank();
  log.success(`Exported ${users.length} user${users.length === 1 ? "" : "s"} to ${outputPath}`);
  log.info(dim(`Run ${record.id}. See each user with \`clerk migrate runs ${record.id}\`.`));

  log.blank();
  log.info(dim(ACCOUNT_LINKING_NOTE));

  log.blank();
  for (const line of formatImportCommand(record.id)) log.info(line);

  return { record, outputPath };
}
