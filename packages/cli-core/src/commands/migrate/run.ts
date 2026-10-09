/**
 * `clerk migrate import <file|export-run-id>` — the user import itself.
 *
 * Registered as the `import` subcommand. The exported handler keeps the name
 * `run` because `import` is a reserved word.
 *
 * An import goes through the same steps every time:
 *
 * 1. Settle the file (an export run ID stands for the file that run wrote),
 *    the source (a file from `clerk migrate export` names its own) and the
 *    target instance, and print the target.
 * 2. Decide whether this continues an earlier run of the same file, source and
 *    instance, from the run store.
 * 3. Run `checkImport()` against the real instance. `--dry-run` stops here.
 * 4. Refuse on any reject unless `--allow-partial`, then ask for consent.
 *    Nothing is written without `--yes` or a yes at the prompt.
 * 5. Import, one run line per user.
 */

import path from "node:path";
import { bold, dim, green, red, yellow } from "../../lib/color.ts";
import { resolveProfile } from "../../lib/config.ts";
import { hasAccountCredentials } from "../../lib/credential-store.ts";
import {
  AUTH_ERROR_REASON,
  AuthError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import { resolveKeylessTarget } from "../../lib/keyless-target.ts";
import { quoteArg } from "../../lib/json-body.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS, printAgentNextSteps } from "../../lib/next-steps.ts";
import { confirm } from "../../lib/prompts.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { importUsers } from "./import-users.ts";
import { checkImport, type ImportChecks } from "./lib/checks.ts";
import { fetchInstanceSettings, fetchUserCount } from "./lib/clerk-config.ts";
import { readEnvelope, type ExportEnvelope } from "./lib/export-file.ts";
import {
  firebaseHashConfigProblem,
  fingerprintFirebaseHashConfig,
  resolveFirebaseHashConfig,
  type FirebaseHashFlags,
} from "./lib/firebase-hash.ts";
import { DEV_USER_LIMIT, resolveLimits, type InstanceType } from "./lib/instance.ts";
import {
  continueRun,
  latestUserLines,
  listRuns,
  liveLockPid,
  lockFile,
  lockImport,
  readRun,
  readUserLines,
  resolveRunsDir,
  RUN_ID_PATTERN,
  runDir,
  runState,
  sha256File,
  startRun,
  type Run,
  type RunRecord,
  type UserLine,
} from "./lib/run-store.ts";
import { withProgress } from "./lib/progress.ts";
import { createApiScheduler } from "./lib/scheduler.ts";
import { readSupabaseRows } from "./lib/supabase-providers.ts";
import { keyInstanceId, printTarget, resolveClerkTarget } from "./lib/target.ts";
import { findInFlight } from "./lib/user-lookup.ts";
import {
  fileExists,
  getFileType,
  loadUsersFromFile,
  resolveImportFilePath,
} from "./lib/transform.ts";
import { resolveSource, sourceKeys } from "./sources/registry.ts";
import type { ImportSummary, User } from "./types.ts";
import { promptForFile, promptForFirebaseHashConfig, promptForSource } from "./wizard.ts";
import { login } from "../auth/login.ts";
import { link } from "../link/index.ts";

export type MigrateRunOptions = {
  /** An export file, or the ID of the export run that wrote one. */
  input?: string;
  /** A built-in source key, or the path to a source you wrote. */
  source?: string;
  /** Content hash of a custom `--source`, set once it is loaded. */
  sourceHash?: string;
  /** `--source` as typed, for printed commands: a custom source's path. Not a flag. */
  sourceArg?: string;
  /** The file to read, once `input` is resolved. Not a flag. */
  file?: string;
  requirePassword?: boolean;
  /**
   * Import users with no legal acceptance into an instance that requires it.
   * Without it, a prompt asks; where nobody can be asked, they are rejected.
   */
  skipLegalChecks?: boolean;
  /** Check against the instance, report, and write nothing. */
  dryRun?: boolean;
  /** Import the users that pass, and record the rest as skipped. */
  allowPartial?: boolean;
  /** Start a fresh run even when an earlier one matches. */
  newRun?: boolean;
  yes?: boolean;
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
} & FirebaseHashFlags;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Nobody can answer a prompt: an agent, a non-TTY run, or `--json`. */
function canPrompt(options: MigrateRunOptions): boolean {
  return !options.json && isHuman() && !isAgent();
}

/**
 * Validates what a run needs before anything is read or sent.
 *
 * `--source` has already been resolved to a registered key by the time this
 * runs, custom sources included.
 *
 * @returns The source key and file path, both guaranteed present.
 */
export function validateRunOptions(options: MigrateRunOptions): {
  source: string;
  file: string;
} {
  if (!options.source) {
    throwUsageError(
      `Missing --source. Valid values: ${sourceKeys().join(", ")}, or the path to a source you wrote.`,
      undefined,
      ERROR_CODE.USAGE_ERROR,
      [
        {
          command: "clerk migrate import users.json --source clerk --yes",
          description: "Import a Clerk export",
        },
      ],
    );
  }
  if (!options.file) {
    throwUsageError(
      "Missing the file to import (a JSON or CSV export, or an export run ID).",
      undefined,
      ERROR_CODE.USAGE_ERROR,
      [
        {
          command: "clerk migrate import users.json --source clerk --yes",
          description: "Import a Clerk export",
        },
      ],
    );
  }
  if (!fileExists(options.file)) {
    throw new CliError(`File not found: ${options.file}`, { code: ERROR_CODE.FILE_NOT_FOUND });
  }
  if (!getFileType(options.file)) {
    throwUsageError(`Unsupported file type for ${options.file}. Provide a .json or .csv file.`);
  }

  return { source: options.source, file: options.file };
}

/** Where a production instance's operator changes the SMS country blocklist. */
const SMS_SETTINGS_URL = "https://dashboard.clerk.com/~/customization/sms/settings";

/** Clerk's fictional email addresses and phone numbers, for development. */
const TEST_NUMBERS_URL = "https://clerk.com/docs/guides/development/testing/test-emails-and-phones";

/**
 * What the API's error messages leave out: whether the operator can do
 * something about them, and where.
 *
 * Both of these read as account-level restrictions and are not. Blocked
 * countries are a per-instance SMS blocklist that development instances are
 * created with far more of, and the user limit is a development-instance quota
 * that production does not have by default — so "contact support", which both
 * messages point at, is the wrong first move for most readers.
 *
 * @returns One note per recognized error family, empty when none apply.
 */
export function explainErrors(errors: Iterable<string>, instanceType: InstanceType): string[] {
  const all = [...errors];
  const notes: string[] = [];

  if (all.some((error) => error.includes("Phone numbers from this country"))) {
    notes.push(
      instanceType === "dev"
        ? `Development instances block SMS to most countries by default — this is not a limit on your account. ` +
            `Use Clerk's test phone numbers while developing (${TEST_NUMBERS_URL}), and contact support only if ` +
            `you need real numbers in a specific country before going to production.`
        : `Unblock the countries you need under SMS settings in the Dashboard (${SMS_SETTINGS_URL}). ` +
            `Plans without SMS support cannot remove them; contact support if the setting is refused.`,
    );
  }

  // Production has no user limit unless a plan imposes one, and the API's own
  // message already names the fix ("upgrade to a paid plan") in that case.
  if (
    instanceType === "dev" &&
    all.some((error) => /You have reached your limit of \d+ users/.test(error))
  ) {
    notes.push(
      `The user limit is a development-instance quota (${DEV_USER_LIMIT} by default). Import into a production ` +
        `instance to bring everyone across, or contact support to raise this instance's limit.`,
    );
  }

  return notes;
}

// --- Settling the file, source and target ----------------------------------

/**
 * Makes sure there is somewhere to import *into* before anything else happens.
 *
 * Without this the first complaint comes from deep inside the secret-key chain,
 * which resolves the linked profile before it ever asks for a token — so a
 * signed-out operator in an unlinked directory is told to `clerk link`, a
 * command that will only turn around and ask them to sign in.
 *
 * A human gets the same sign-in-then-link flow `clerk link` already runs. An
 * agent cannot answer a browser login or an application picker, so it gets the
 * error naming whichever half is missing.
 */
async function ensureImportTarget(options: MigrateRunOptions): Promise<void> {
  // A secret key names the destination instance on its own, with no account
  // and no linked directory involved — mirroring resolveBapiSecretKey, which
  // takes `--app` over an exported CLERK_SECRET_KEY.
  if (options.secretKey || (!options.app && process.env.CLERK_SECRET_KEY)) return;
  // `--app` names it too, but resolves its key through the Platform API, which
  // needs an account: it goes through the sign-in below, though not the link.
  // An unclaimed accountless application keeps its only secret key on disk.
  if (!options.app && (await resolveKeylessTarget({ instance: options.instance }))) return;

  const interactive = canPrompt(options);

  if (!(await hasAccountCredentials())) {
    if (!interactive) {
      throw new AuthError({
        reason: AUTH_ERROR_REASON.NOT_LOGGED_IN,
        message:
          "Not logged in, so there is no Clerk instance to import into. Run `clerk auth login`, then `clerk link`.",
        examples: [
          { command: "clerk auth login", description: "Sign in, then re-run the import" },
          {
            command:
              "clerk migrate import users.json --source clerk --yes --secret-key sk_test_...",
            description: "Import without signing in",
          },
        ],
      });
    }
    log.info("Not logged in. Signing in first...");
    await login({ showNextSteps: false });
  }

  // Left to the secret-key chain when non-interactive: its `not_linked` error
  // is the one every other command raises, and there is nothing to add to it.
  if (interactive && !options.app && !(await resolveProfile(process.cwd()))) {
    log.info("This directory isn't linked to a Clerk application. Linking one first...");
    await link({ skipIfLinked: true });
  }
}

/**
 * Settles which file to read. The argument may name the export run that wrote
 * the file; a human who gave none is asked for a path.
 */
async function resolveInput(
  options: MigrateRunOptions,
): Promise<{ file: string; fromExport?: string; exportSha256?: string }> {
  const value = options.input;
  if (!value) {
    if (!canPrompt(options)) {
      throwUsageError(
        "`clerk migrate import` needs the file to import, or the export run that wrote it, and cannot prompt here.",
        undefined,
        undefined,
        [
          {
            command: "clerk migrate import 20260929-141502-a1b2 --yes",
            description: "Import what an export run wrote",
          },
          {
            command: "clerk migrate import users.json --source clerk --yes",
            description: "Import a file",
          },
        ],
      );
    }
    return { file: await promptForFile() };
  }
  if (!RUN_ID_PATTERN.test(value) || fileExists(value)) return { file: value };

  const runsDir = await resolveRunsDir(options.runsDir);
  const record = readRun(runsDir, value);
  if (!record) {
    throwUsageError(`No run \`${value}\` in ${runsDir}. Run \`clerk migrate runs\` to list them.`);
  }
  if (record.kind !== "export" || !record.file) {
    throwUsageError(
      `Run ${value} is an ${record.kind} run, which has no file to import. Name an export run, or a file.`,
    );
  }
  // `--output` can point a later export, or an edit, at the same path. The run
  // ID has to still mean the file that run wrote, not whatever is there now.
  const { path: file, sha256 } = record.file;
  if (!fileExists(file)) {
    throwUsageError(
      `The file run ${value} wrote, ${quoteArg(file)}, is gone. Export again, or import a file by its path.`,
    );
  }
  if (sha256File(file) !== sha256 || readEnvelope(file)?.runId !== record.id) {
    throwChangedExport(value, file);
  }
  // Carried on, so the file is checked again where the users are read: another
  // export can still overwrite the path after this.
  return { file, fromExport: record.id, exportSha256: sha256 };
}

/** A file the import read changed before it finished reading it. */
function throwChangedFile(file: string): never {
  throwUsageError(
    `${quoteArg(file)} changed while it was being imported. Nothing was imported. ` +
      "Run the import again once nothing else is writing to it.",
  );
}

function throwChangedExport(runId: string, file: string): never {
  throwUsageError(
    `The file run ${runId} wrote, ${quoteArg(file)}, has changed since it was exported. Nothing was imported. ` +
      "Import it by its path if you mean its current contents, or export again.",
  );
}

/**
 * Resolves `--source` to a registered key, loading a custom source from its
 * path so the rest of the run treats it exactly like a built-in.
 *
 * @throws UsageError for an unknown key.
 */
async function applySource(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  if (!options.source) return options;
  const resolved = await resolveSource(options.source);
  if (resolved.path && !options.json) {
    log.info(`Loaded the \`${resolved.key}\` source from ${options.source}.`);
  }
  return {
    ...options,
    source: resolved.key,
    sourceArg: options.source,
    ...(resolved.hash ? { sourceHash: resolved.hash } : {}),
  };
}

/**
 * The source an export file names for itself, checked against the one the
 * flags name.
 *
 * @throws UsageError when the two disagree: importing an Auth0 export through
 *   the Supabase mapping would create users with the wrong fields.
 */
function applyEnvelope(
  options: MigrateRunOptions,
  envelope: ExportEnvelope | undefined,
): MigrateRunOptions {
  if (!envelope) return options;
  if (options.source && options.source !== envelope.source) {
    throwUsageError(
      `The file was exported from ${envelope.source}, but --source names ${options.source}. ` +
        "Drop --source: the file already says where it came from.",
    );
  }
  return { ...options, source: envelope.source };
}

// --- Continuing an earlier run ---------------------------------------------

/**
 * Refuses while another process is importing this file, with this source key,
 * into this instance. Checked before any resume matching, and under
 * --new-run too: an edited custom source (another `sourceHash`) or a new run
 * would otherwise send the same external IDs alongside it.
 */
function assertNoActiveImport(
  runsDir: string,
  match: { sha256: string; source: string; instanceId: string; keyInstanceId?: string },
): void {
  const active = listRuns(runsDir).find(
    (record) =>
      record.kind === "import" &&
      record.file?.sha256 === match.sha256 &&
      record.source === match.source &&
      (record.target.instanceId === match.instanceId ||
        record.target.instanceId === match.keyInstanceId) &&
      runState(runsDir, record) === "running",
  );
  if (active) {
    throwUsageError(
      `Run ${active.id} is importing this file right now in another process (PID ${liveLockPid(runsDir, active.id)}). ` +
        `Wait for it to finish. If that process is not a migrate run, delete ${lockFile(runsDir, active.id)}.`,
    );
  }
}

/** How this import relates to earlier runs of the same file, source and instance. */
export type ResumeCase =
  | { kind: "new" }
  | { kind: "continue"; record: RunRecord; because: "interrupted" | "partial" }
  | { kind: "complete"; record: RunRecord };

/**
 * Finds the latest import run of this file (by sha256), this source (and a
 * custom source's hash) and this instance, and decides what a re-run does:
 *
 * - none, or undone: a new run
 * - interrupted: continue it, skipping the users it created
 * - partial: continue it, retrying the users that failed or were skipped
 * - complete: nothing; the file is already in
 *
 * @throws UsageError when that run is still running in another process, or
 *   has an undo that never finished: some of its users are gone and some are
 *   not, so neither continuing it nor starting over is safe.
 */
export function findResume(
  runsDir: string,
  match: {
    sha256: string;
    source: string;
    sourceHash?: string;
    instanceId: string;
    /** The key's stand-in ID, for a run recorded while Clerk could not name the instance. */
    keyInstanceId?: string;
  },
): ResumeCase {
  const latest = listRuns(runsDir).find(
    (record) =>
      record.kind === "import" &&
      record.file?.sha256 === match.sha256 &&
      record.source === match.source &&
      record.sourceHash === match.sourceHash &&
      (record.target.instanceId === match.instanceId ||
        record.target.instanceId === match.keyInstanceId),
  );
  if (!latest) {
    // Clerk did not name the instance (GET /v1/instance failed), so a run of
    // this file recorded under a real ID can be neither matched nor ruled out.
    // Starting over would reject every user it created and leave it unfinished.
    if (match.instanceId.startsWith("key_")) {
      const unconfirmed = listRuns(runsDir).find(
        (record) =>
          record.kind === "import" &&
          record.file?.sha256 === match.sha256 &&
          record.source === match.source &&
          record.target.instanceId?.startsWith("ins_") === true,
      );
      if (unconfirmed) {
        throwUsageError(
          `Clerk did not confirm which instance this key addresses, so this import cannot tell whether run ${unconfirmed.id} is for it. ` +
            "Nothing was imported. Try again, or pass --new-run to start a new run.",
        );
      }
    }
    return { kind: "new" };
  }

  const state = runState(runsDir, latest);
  if (state === "running") {
    throwUsageError(
      `Run ${latest.id} is importing this file right now in another process (PID ${liveLockPid(runsDir, latest.id)}). ` +
        `Wait for it to finish. If that process is not a migrate run, delete ${lockFile(runsDir, latest.id)}.`,
    );
  }
  if (state === "undone") return { kind: "new" };

  const undoRun = listRuns(runsDir).find(
    (record) => record.kind === "undo" && record.undoes === latest.id,
  );
  if (undoRun && runState(runsDir, undoRun) !== "complete") {
    throwUsageError(
      `Run ${latest.id} has an undo that did not finish (run ${undoRun.id}). ` +
        `Finish it with \`clerk migrate undo ${latest.id}\`, or pass --new-run to import into a new run.`,
    );
  }
  // Undone in full, though the import run was never marked so.
  if (undoRun) return { kind: "new" };

  if (state === "complete") return { kind: "complete", record: latest };
  return {
    kind: "continue",
    record: latest,
    because: state === "interrupted" ? "interrupted" : "partial",
  };
}

// --- Reporting -------------------------------------------------------------

/** How many rejected source IDs to name per reason before summing the rest. */
const REJECT_SAMPLE = 5;

function printChecks(checks: ImportChecks): void {
  log.blank();
  log.info(bold("Checks"));
  log.info(`  ${plural(checks.total, "user")} checked`);

  if (checks.rejects.length > 0) {
    log.info(`  ${red("✗")} ${red(`${plural(checks.rejects.length, "user")} rejected`)}`);
    for (const { reason, count } of checks.rejectReasons) {
      const ids = checks.rejects
        .filter((reject) => reject.reason === reason)
        .map((reject) =>
          reject.keptSourceId
            ? `${reject.sourceId} (kept: ${reject.keptSourceId})`
            : reject.sourceId,
        );
      const sample = ids.slice(0, REJECT_SAMPLE).join(", ");
      const more = ids.length > REJECT_SAMPLE ? `, and ${ids.length - REJECT_SAMPLE} more` : "";
      log.info(`      ${count}: ${reason}`);
      log.info(`         ${dim(sample + more)}`);
    }
  }

  if (checks.warnings.length > 0) {
    log.info(`  ${yellow("⚠")} ${yellow("Imported, but not everything comes across")}`);
    for (const warning of checks.warnings) log.info(`      ${dim(warning)}`);
  }

  log.info(`  ${green("✓")} ${green(`${plural(checks.importable.length, "user")} to import`)}`);

  if (checks.settingsUnavailable) {
    log.info(
      `  ${yellow("!")} ${dim("Could not read this instance's settings, so required fields were not checked.")}`,
    );
  }

  if (checks.fixes.length > 0) {
    log.blank();
    log.info(bold("Or change the instance instead"));
    for (const fix of checks.fixes) {
      log.info(`  ${fix.label}`);
      log.info(dim(`    ${fix.command ?? fix.url}`));
    }
  }
}

function checksJson(checks: ImportChecks) {
  return {
    total: checks.total,
    importable: checks.importable.length,
    rejects: checks.rejects,
    rejectReasons: checks.rejectReasons,
    warnings: checks.warnings,
    fixes: checks.fixes,
    ...(checks.quota ? { quota: checks.quota } : {}),
    settingsUnavailable: checks.settingsUnavailable,
  };
}

function formatSummary(
  summary: ImportSummary,
  skipped: number,
  record: RunRecord,
  runFolder: string,
  instanceType: InstanceType,
): string[] {
  const lines = [
    `${green("Imported:")} ${summary.successful}`,
    `${red("Failed:")} ${summary.failed}`,
  ];
  if (skipped > 0) lines.push(`${yellow("Skipped:")} ${skipped}`);
  // The user quota stopped the run: these go out on a re-run.
  if (summary.notSent > 0) lines.push(`${yellow("Not sent:")} ${summary.notSent}`);
  // Printed here, after the progress bar, which would redraw over it mid-run.
  if (summary.stopReason) {
    lines.push(
      "",
      yellow(
        "No more users were sent. Once the limit is raised, run the import again to send them.",
      ),
    );
  }

  if (summary.errorBreakdown.size > 0) {
    lines.push("", bold("Error breakdown:"));
    for (const [error, count] of summary.errorBreakdown) {
      lines.push(`  ${plural(count, "user")}: ${error}`);
    }
  }
  // Imported, so not failures, but the phone is gone: say so, and why.
  if (summary.droppedPhones.size > 0) {
    lines.push("", bold("Imported without their phone:"));
    for (const [reason, count] of summary.droppedPhones) {
      lines.push(`  ${plural(count, "user")}: ${reason}`);
    }
  }
  const explained = [...summary.errorBreakdown.keys(), ...summary.droppedPhones.keys()];
  for (const note of explainErrors(explained, instanceType)) lines.push("", note);
  lines.push("", dim(`Run ${record.id}: ${runFolder}`));
  return lines;
}

/**
 * Once every user is in, the files that hold them are only a liability: the
 * export carries user data and password hashes, and the run is only needed
 * for `undo`.
 */
function cleanupLines(runsDir: string, record: RunRecord): string[] {
  const lines: string[] = [];
  if (record.fromExport) {
    const exportDir = runDir(runsDir, record.fromExport);
    // `export --output` writes the file outside the run folder, and deleting
    // the folder alone would leave the password hashes on disk.
    const file = record.file?.path;
    const outside = file && path.relative(exportDir, file).startsWith("..");
    lines.push(
      `The export in run ${record.fromExport} holds your users' data. Once you have checked the import, delete it:`,
      dim(`  rm -rf ${quoteArg(exportDir)}`),
      ...(outside ? [dim(`  rm ${quoteArg(file)}`)] : []),
    );
  }
  lines.push(
    `Keep run ${record.id} while you might still undo it. After that:`,
    dim(`  rm -rf ${quoteArg(runDir(runsDir, record.id))}`),
  );
  return lines;
}

// --- The import ------------------------------------------------------------

/**
 * The exact command that would carry on from here, for the consent and
 * refusal messages. Every value is shell-quoted; secrets are placeholders.
 */
function commandFor(options: MigrateRunOptions, fromExport: string | undefined, extra: string[]) {
  const input = fromExport ?? options.input ?? options.file ?? "<file>";
  const parts = ["clerk migrate import", quoteArg(input)];
  const source = options.sourceArg ?? options.source;
  if (!fromExport && source) parts.push("--source", quoteArg(source));
  if (options.allowPartial) parts.push("--allow-partial");
  if (options.newRun) parts.push("--new-run");
  if (options.requirePassword) parts.push("--require-password");
  if (options.skipLegalChecks) parts.push("--skip-legal-checks");
  // Names, not `<…>`: pasted as is, a shell reads `<key>` as a redirect.
  if (options.firebaseSignerKey) parts.push("--firebase-signer-key", "SIGNER_KEY");
  if (options.firebaseSaltSeparator !== undefined)
    parts.push("--firebase-salt-separator", "SALT_SEPARATOR");
  if (options.firebaseRounds) parts.push("--firebase-rounds", "ROUNDS");
  if (options.firebaseMemCost) parts.push("--firebase-mem-cost", "MEM_COST");
  if (options.secretKey) parts.push("--secret-key", "<key>");
  if (options.app) parts.push("--app", quoteArg(options.app));
  if (options.instance) parts.push("--instance", quoteArg(options.instance));
  if (options.runsDir) parts.push("--runs-dir", quoteArg(options.runsDir));
  if (options.json) parts.push("--json");
  return [...parts, ...extra].join(" ");
}

/**
 * A continued run, linked to the export run it now reads from: one started
 * by path and continued by export run ID would otherwise lack the link, and
 * the cleanup would not name the export holding the users' data.
 */
function continueWithExport(run: Run, fromExport: string | undefined): Run {
  if (fromExport && run.record.fromExport !== fromExport) run.update({ fromExport });
  return run;
}

/**
 * Records the checks' rejects as skipped users, so the run says who they were.
 * The checks never reject an adopted user: it is created already.
 */
function recordRejects(run: Run, checks: ImportChecks): void {
  for (const { sourceId, reason, keptSourceId } of checks.rejects) {
    run.append({
      sourceId,
      status: "skipped",
      reason: keptSourceId ? `${reason} (kept: ${keptSourceId})` : reason,
    });
  }
}

export async function run(rawOptions: MigrateRunOptions): Promise<void> {
  // Released however the import ends: a return, a refusal or a Ctrl-C.
  const lock: ImportLock = {};
  try {
    await runImport(rawOptions, lock);
  } finally {
    lock.release?.();
  }
}

/** The import's identity lock, taken part-way through and released by {@link run}. */
type ImportLock = { release?: () => void };

async function runImport(rawOptions: MigrateRunOptions, lock: ImportLock): Promise<void> {
  await ensureImportTarget(rawOptions);
  let options = await applySource(rawOptions);

  const input = await resolveInput(options);
  options = { ...options, file: input.file };
  // Hashed before the envelope is read: the envelope and the users are read
  // separately, so each later read is checked against this revision.
  const readSha256 = fileExists(input.file)
    ? sha256File(resolveImportFilePath(input.file))
    : undefined;
  const envelope = fileExists(input.file)
    ? readEnvelope(resolveImportFilePath(input.file))
    : undefined;
  // The revision the import must read throughout: the one an export run
  // recorded, or the one the envelope came from.
  const expectedSha256 = input.exportSha256 ?? readSha256;
  const throwChanged = (filePath: string): never =>
    input.fromExport ? throwChangedExport(input.fromExport, filePath) : throwChangedFile(filePath);
  options = applyEnvelope(options, envelope);

  // Asked only when the file does not say where it came from.
  if (!options.source && canPrompt(options) && fileExists(input.file)) {
    options = { ...options, source: await promptForSource() };
  }

  const { source, file } = validateRunOptions(options);
  // The flags win, so a rotated key can be passed without re-exporting.
  const fromFlags = resolveFirebaseHashConfig(options, source);
  let firebaseHashConfig = fromFlags ?? (source === "firebase" ? envelope?.firebase : undefined);
  let configFrom = fromFlags ? "the --firebase-* flags" : "the export file";
  if (source === "firebase" && !firebaseHashConfig && canPrompt(options)) {
    firebaseHashConfig = await promptForFirebaseHashConfig();
    configFrom = "the parameters entered";
  }
  // Wherever they came from, each goes into every password digest.
  const problem = firebaseHashConfig && firebaseHashConfigProblem(firebaseHashConfig);
  if (problem) {
    throwUsageError(
      `The Firebase hash parameters from ${configFrom} won't work: ${problem}. Nothing was imported.\n` +
        "Find all four in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
      "https://clerk.com/docs/guides/development/migrating/firebase",
    );
  }

  await withGutter(
    "Migrating users to Clerk",
    async ({ setNextSteps }) => {
      const { secretKey, target } = await resolveClerkTarget(options);
      if (!options.json) printTarget(target);
      const limits = resolveLimits(secretKey);

      const filePath = resolveImportFilePath(file);
      const sha256 = sha256File(filePath);
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) throwChanged(filePath);
      const runsDir = await resolveRunsDir(options.runsDir);

      // Held from before the checks to the end of the run: the scan below
      // alone leaves a gap a second process can pass through before either
      // one writes a run.
      if (!options.dryRun) {
        lock.release = lockImport(runsDir, { sha256, source, instanceId: target.instanceId });
      }
      assertNoActiveImport(runsDir, {
        sha256,
        source,
        instanceId: target.instanceId,
        keyInstanceId: keyInstanceId(secretKey),
      });
      const resume: ResumeCase = options.newRun
        ? { kind: "new" }
        : findResume(runsDir, {
            sha256,
            source,
            ...(options.sourceHash ? { sourceHash: options.sourceHash } : {}),
            instanceId: target.instanceId,
            keyInstanceId: keyInstanceId(secretKey),
          });

      // The users this run created carry digests built from its parameters, so
      // the rest must be built from the same ones. A run from before this was
      // recorded has none to compare, and continues as it did.
      const firebaseHash = firebaseHashConfig
        ? fingerprintFirebaseHashConfig(firebaseHashConfig)
        : undefined;
      if (
        resume.kind === "continue" &&
        resume.record.firebaseHash &&
        resume.record.firebaseHash !== firebaseHash
      ) {
        throwUsageError(
          `Run ${resume.record.id} imported this file with different Firebase hash parameters, and the users it created carry digests built from them. Nothing was imported.\n` +
            "Pass the same --firebase-* flags to continue it, or --new-run to start a new run.",
        );
      }

      if (resume.kind === "complete") {
        if (options.json) {
          log.data(JSON.stringify({ target, run: resume.record, alreadyImported: true }, null, 2));
        } else {
          log.success(
            `Already imported in run ${resume.record.id}. Pass --new-run to import it again.`,
          );
        }
        return;
      }

      // Users the run being continued already created are done: they are not
      // checked or sent again. Those whose extra identifiers never attached
      // get just the attaches.
      const continued = resume.kind === "continue" ? resume.record : undefined;
      // What the plan below is built from; checked again once the run's lock
      // is held, since a prompt can wait while an undo or a continue writes.
      const plannedLines = continued ? readUserLines(runsDir, continued.id).length : undefined;
      const done = new Map<string, string>();
      const attachOnly: UserLine[] = [];
      const inFlight: string[] = [];
      if (continued) {
        for (const line of latestUserLines(runsDir, continued.id).values()) {
          if (line.status === "creating") inFlight.push(line.sourceId);
          if (line.status !== "created" || !line.clerkId) continue;
          done.set(line.sourceId, line.clerkId);
          if (line.pending?.length) attachOnly.push(line);
        }
      }

      // Creates the run stopped with no answer to. Those Clerk holds are
      // adopted: checked as usual, but never created again.
      const schedule = createApiScheduler(limits.concurrencyLimit, limits.rateLimit);
      const adopted = new Map<string, string>();
      if (continued) {
        const found = await findInFlight({
          runId: continued.id,
          sourceIds: inFlight,
          secretKey,
          schedule,
        });
        for (const user of found) adopted.set(user.sourceId, user.clerkId);
      }

      if (!options.json) {
        log.info(
          resume.kind === "continue"
            ? `Continuing run ${resume.record.id}, which ${resume.because === "interrupted" ? "was interrupted" : "finished partial"}: ` +
                `${plural(done.size, "user")} already imported ${done.size === 1 ? "is" : "are"} left alone.`
            : "Starting a new run.",
        );
        if (adopted.size > 0) {
          log.info(
            `${plural(adopted.size, "user")} whose create was cut off ${adopted.size === 1 ? "is" : "are"} already in the instance, and won't be created again.`,
          );
        }
      }

      const loaded = await withSpinner(`Loading users from ${file}...`, async () =>
        loadUsersFromFile(file, source, { context: { firebaseHashConfig } }),
      );
      let users = loaded.users.filter((user) => !done.has(user.userId));
      const failures = loaded.failures.filter((failure) => !done.has(failure.userId));

      // An instruction about this import, not a prediction: users without a
      // password are left out of the job rather than recorded as skipped.
      let withoutPassword: User[] = [];
      if (options.requirePassword) {
        withoutPassword = users.filter((user) => !user.password && !adopted.has(user.userId));
        if (withoutPassword.length > 0 && !options.json) {
          log.info(
            `--require-password: leaving out ${plural(withoutPassword.length, "user")} without a password.`,
          );
        }
        // A Set, not `includes`: half a large Supabase export can lack a
        // password, and a scan per user would stall before any check runs.
        const leftOut = new Set(withoutPassword);
        users = users.filter((user) => !leftOut.has(user));
      }

      let supabaseRows: Record<string, unknown>[] | undefined;
      if (source === "supabase") {
        try {
          supabaseRows = await readSupabaseRows(file);
        } catch (error) {
          log.debug(`migrate: could not read Supabase providers: ${String(error)}`);
        }
      }

      // Checked again after the last read of the file, before anything is
      // created: the envelope, the users and the provider rows all came from
      // one revision, the one an export run recorded if there is one.
      if (expectedSha256 !== undefined && sha256File(filePath) !== expectedSha256) {
        throwChanged(filePath);
      }

      const [settings, existingUsers] = await withSpinner("Checking the instance...", async () =>
        Promise.all([
          fetchInstanceSettings(secretKey),
          limits.instanceType === "dev" ? fetchUserCount(secretKey) : Promise.resolve(null),
        ]),
      );

      // Creating a user without legal acceptance needs consent of its own:
      // the flag, or a yes at a prompt. Otherwise the checks reject them.
      let skipLegalChecks = options.skipLegalChecks ?? false;
      const withoutLegal = settings?.sign_up?.legal_consent_enabled
        ? users.filter((user) => !user.legalAcceptedAt && !user.skipLegalChecks).length
        : 0;
      // `-y` imports without prompting, so it does not stop here either: the
      // checks reject these users, and --skip-legal-checks is the way through.
      if (
        !skipLegalChecks &&
        withoutLegal > 0 &&
        !options.dryRun &&
        !options.yes &&
        canPrompt(options)
      ) {
        skipLegalChecks = await confirm({
          message: `${plural(withoutLegal, "user")} ${withoutLegal === 1 ? "has" : "have"} no legal acceptance on record, which this instance requires. Import them without it?`,
          default: false,
        });
      }

      const checks = await withSpinner("Checking users against the instance...", async (spinner) =>
        checkImport({
          users,
          skipLegalChecks,
          failures,
          unknownFields: loaded.unknownFields,
          ...(supabaseRows ? { supabaseRows } : {}),
          settings,
          existingUsers,
          instanceType: limits.instanceType,
          target,
          secretKey,
          schedule,
          adoptedClerkIds: new Set(adopted.values()),
          adoptedSourceIds: new Set(adopted.keys()),
          spinner,
        }),
      );

      const refused = checks.rejects.length > 0 && !options.allowPartial;
      // The users --require-password left out never reach the checks, so the
      // JSON says how many, or `checks.total` would not add up to the file.
      const leftOut = withoutPassword.length > 0 ? { withoutPassword: withoutPassword.length } : {};
      const preview = (extra: Record<string, unknown>) =>
        log.data(
          JSON.stringify(
            {
              target,
              run: continued ?? null,
              resume: resume.kind,
              checks: checksJson(checks),
              ...leftOut,
              ...extra,
            },
            null,
            2,
          ),
        );

      if (!options.json) printChecks(checks);

      if (options.dryRun) {
        if (options.json) preview({ dryRun: true });
        else {
          log.blank();
          log.info(dim("Dry run: nothing was written."));
        }
        // The exit code says what the real run would do.
        if (refused) process.exitCode = 2;
        return;
      }

      if (refused) {
        if (options.json) preview({ refused: true });
        throwUsageError(
          `${plural(checks.rejects.length, "user")} would be rejected, so nothing was imported. ` +
            "Fix them, or pass --allow-partial to import the rest and record them as skipped.",
          undefined,
          undefined,
          [
            {
              command: commandFor(options, input.fromExport, ["--allow-partial", "--yes"]),
              description: "Import the users that pass",
            },
          ],
        );
      }

      if (
        checks.importable.length === 0 &&
        checks.rejects.length === 0 &&
        withoutPassword.length === 0 &&
        attachOnly.length === 0
      ) {
        // Settled, so a continued run is finished rather than left interrupted.
        if (continued) continueRun(runsDir, continued, plannedLines).finish();
        if (options.json) preview({ nothingToImport: true });
        else log.warn("No users left to import.");
        return;
      }

      // Rule 1: nothing is written without consent — `--yes`, or a yes at a
      // prompt. An agent, a non-TTY run and `--json` never prompt. With users
      // skipped, the question names them: "Import 0 users?" hides the skips.
      const toCreate = plural(checks.importable.length, "user");
      const skipping = checks.rejects.length + withoutPassword.length;
      const skips = skipping > 0 ? ` and skip ${plural(skipping, "user")}` : "";
      if (!options.yes) {
        if (!canPrompt(options)) {
          if (options.json) preview({ consent: "required" });
          throwUsageError(
            `\`clerk migrate import\` will create ${toCreate}${skips}. Pass --yes to confirm.`,
            undefined,
            undefined,
            [
              {
                command: commandFor(options, input.fromExport, ["--yes"]),
                description: "Run the import",
              },
            ],
          );
        }
        log.blank();
        const proceed = await confirm({
          message: skips ? `Create ${toCreate}${skips}?` : `Import ${toCreate}?`,
          default: false,
        });
        if (!proceed) throwUserAbort();
      }

      // Gitignored only now, once there is consent to write a run.
      await resolveRunsDir(options.runsDir, { write: true });
      const run = continued
        ? continueWithExport(continueRun(runsDir, continued, plannedLines), input.fromExport)
        : startRun(runsDir, {
            kind: "import",
            target,
            source,
            ...(options.sourceHash ? { sourceHash: options.sourceHash } : {}),
            file: { path: filePath, sha256 },
            ...(input.fromExport ? { fromExport: input.fromExport } : {}),
            ...(firebaseHash ? { firebaseHash } : {}),
          });
      // Printed now, not on the way out: on a Ctrl-C the signal handler exits
      // before the import returns, and the folder is the only record of who
      // was created.
      log.info(`Run ${run.record.id}: ${run.dir}`);
      recordRejects(run, checks);
      for (const user of withoutPassword) {
        run.append({
          sourceId: user.userId,
          status: "skipped",
          reason: "no password (--require-password)",
        });
      }

      const summary: ImportSummary =
        checks.importable.length > 0 || attachOnly.length > 0
          ? await withProgress(
              { total: checks.importable.length, verb: "created" },
              async (progress) =>
                importUsers({
                  users: checks.importable,
                  secretKey,
                  limits,
                  record: run.append,
                  runId: run.record.id,
                  attachOnly,
                  adopted,
                  skipPasswordRequirement: !options.requirePassword,
                  progress,
                }),
            )
          : {
              totalProcessed: 0,
              successful: 0,
              failed: 0,
              notSent: 0,
              droppedPhones: new Map(),
              validationFailed: 0,
              errorBreakdown: new Map(),
            };
      // A Ctrl-C returns the import early, and the users it never sent have
      // no line to count. Left unfinished, the run reads as interrupted, and
      // the throw closes the gutter as paused, when the signal handler has not
      // already exited.
      if (interruptedExitCode() !== null) {
        run.release();
        throwUserAbort();
      }
      const record = run.finish({ notSent: summary.notSent });
      if (summary.failed > 0) process.exitCode = 1;

      if (options.json) {
        log.data(
          JSON.stringify(
            {
              target,
              run: record,
              resume: resume.kind,
              checks: checksJson(checks),
              ...leftOut,
              result: {
                created: summary.successful,
                failed: summary.failed,
                notSent: summary.notSent,
                ...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
                skipped: checks.rejects.length + withoutPassword.length,
                errors: [...summary.errorBreakdown].map(([error, count]) => ({ error, count })),
                warnings: [...summary.droppedPhones].map(([reason, count]) => ({
                  warning: `imported without their phone: ${reason}`,
                  count,
                })),
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      log.blank();
      for (const line of formatSummary(
        summary,
        checks.rejects.length + withoutPassword.length,
        record,
        run.dir,
        limits.instanceType,
      )) {
        log.info(line);
      }
      if (record.status === "complete") {
        log.blank();
        for (const line of cleanupLines(runsDir, record)) log.info(line);
      }

      const steps =
        summary.failed > 0
          ? NEXT_STEPS.MIGRATE_DONE_WITH_ERRORS(record.id)
          : NEXT_STEPS.MIGRATE_DONE(record.id);
      setNextSteps(steps);
      printAgentNextSteps(steps);
    },
    { skip: Boolean(options.json) },
  );
}
