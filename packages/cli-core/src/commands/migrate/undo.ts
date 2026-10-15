/**
 * `clerk migrate undo <run-id>` — delete the users an import created.
 *
 * The import run is the whole record of what to delete: every source ID whose
 * latest line is `created`, by the Clerk ID recorded next to it. Nothing is
 * matched by searching the instance, so nothing the import did not create is
 * ever in scope.
 *
 * Refuses (exit 2) rather than guessing when:
 * - the resolved key addresses a different instance than the run imported into
 * - the run is not an import
 * - the run has already been undone
 *
 * The undo is a run of its own (`kind: "undo"`, `undoes: <id>`). The import is
 * marked `undone` only once every user is gone. A partial undo exits 1, and
 * running `undo` again continues the same undo run.
 */

import { bapiRequest } from "../../lib/bapi.ts";
import { bold, dim, green, red } from "../../lib/color.ts";
import { BapiError, CliError, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner, type SpinnerControls } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { failureOf, tallyError } from "./import-users.ts";
import { carryFlags, undoCommand } from "./lib/carry-flags.ts";
import { terminal } from "./lib/terminal.ts";
import { resolveLimits, type ResolvedLimits } from "./lib/instance.ts";
import { retryOn429 } from "./lib/retry.ts";
import {
  continueRun,
  latestUserLines,
  lockRun,
  patchRun,
  readRun,
  readUserLines,
  resolveRunsDir,
  runState,
  startRun,
  type Run,
  type RunRecord,
  openUndoOf,
  inUseMessage,
} from "./lib/run-store.ts";
import { withProgress, type ProgressUpdate } from "./lib/progress.ts";
import { createApiScheduler, type ApiScheduler } from "./lib/scheduler.ts";
import {
  type ClerkTarget,
  describeTarget,
  isStandInInstanceId,
  keyInstanceId,
  printTarget,
  resolveClerkTarget,
} from "./lib/target.ts";
import { plural } from "./lib/plural.ts";
import { findInFlight, lookupUsers, type SourceUser } from "./lib/user-lookup.ts";

export type UndoOptions = {
  dryRun?: boolean;
  yes?: boolean;
  /** With `--yes`, also delete users who have signed in since the import. */
  includeSignedIn?: boolean;
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  runsDir?: string;
};

/** One user the import created, still to be deleted. */
export type UndoUser = SourceUser;

export type UndoPreview = {
  /** Users that will be deleted. */
  toDelete: number;
  /** Of those, how many have signed in since the import started. */
  signedInSince: number;
  /** Users the import created that are already gone from the instance. */
  alreadyGone: number;
  /** Users an earlier attempt at this undo already deleted. */
  alreadyDeleted: number;
};

/** Loads the import run, refusing anything that cannot be undone. */
function readImportRun(runsDir: string, runId: string): RunRecord {
  const record = readRun(runsDir, runId);
  if (!record) {
    throwUsageError(`No run \`${runId}\` in ${runsDir}. Run \`clerk migrate runs\` to list them.`);
  }
  if (record.kind !== "import") {
    throwUsageError(
      `Run ${runId} is an ${record.kind} run. Only an import run can be undone.`,
      undefined,
      undefined,
      [{ command: "clerk migrate runs", description: "Find the import run to undo" }],
    );
  }
  if (record.status === "undone") {
    throwUsageError(`Run ${runId} was already undone by run ${record.undoneBy ?? "(unknown)"}.`);
  }
  if (runState(runsDir, record) === "running") {
    throwUsageError(
      inUseMessage(runsDir, runId, "running", "Wait for it to finish, then undo it."),
    );
  }
  return record;
}

/** Refuses to delete from an instance the import did not write to. */
function assertSameInstance(record: RunRecord, target: ClerkTarget, secretKey: string): void {
  if (record.target.instanceId === target.instanceId) return;
  // Recorded under the key's stand-in ID while Clerk could not name the
  // instance: the same key is the same instance.
  if (record.target.instanceId === keyInstanceId(secretKey)) return;
  // A `key_` ID is the fallback for an instance lookup that failed. It cannot
  // be compared with an `ins_` ID, so this is "unknown", not "different".
  const unconfirmed = [record.target.instanceId, target.instanceId].some(isStandInInstanceId);
  if (unconfirmed) {
    throwUsageError(
      `Could not confirm that the resolved key addresses the instance run ${record.id} imported into: ` +
        "Clerk did not answer GET /v1/instance (often rate limiting straight after a large import). " +
        "Nothing was deleted. Try again in a minute; --verbose shows the response.",
    );
  }
  throwUsageError(
    `Run ${record.id} imported into ${describeTarget(record.target)}, but the resolved key ` +
      `addresses ${describeTarget(target)}. Nothing was deleted.\n` +
      "Target the instance the import used with --secret-key, --app or --instance.",
  );
}

/**
 * Every user the import created, minus those an earlier undo already deleted.
 *
 * `unconfirmed` holds the source IDs whose create was in flight when the run
 * stopped: they may exist in Clerk with no ID on record.
 */
function usersToDelete(
  runsDir: string,
  record: RunRecord,
  openUndo: RunRecord | undefined,
): { users: UndoUser[]; unconfirmed: string[]; alreadyDeleted: number } {
  const deleted = new Set<string>();
  if (openUndo) {
    for (const line of latestUserLines(runsDir, openUndo.id).values()) {
      if (line.status === "deleted") deleted.add(line.sourceId);
    }
  }

  const users: UndoUser[] = [];
  const unconfirmed: string[] = [];
  for (const line of latestUserLines(runsDir, record.id).values()) {
    if (deleted.has(line.sourceId)) continue;
    if (line.status === "creating") unconfirmed.push(line.sourceId);
    if (line.status !== "created" || !line.clerkId) continue;
    users.push({ sourceId: line.sourceId, clerkId: line.clerkId });
  }
  return { users, unconfirmed, alreadyDeleted: deleted.size };
}

/**
 * Reads each user back from the instance, for the preview.
 *
 * @returns The users still there, and how many of them have signed in since
 *   the import started — the ones whose deletion someone will notice.
 */
async function inspectUsers(options: {
  users: UndoUser[];
  since: string;
  secretKey: string;
  schedule: ApiScheduler;
  spinner?: SpinnerControls;
}): Promise<{
  present: UndoUser[];
  gone: UndoUser[];
  /** The Clerk IDs of the users who signed in since the import. */
  signedIn: string[];
}> {
  const found = await lookupUsers({
    filter: "user_id",
    values: options.users.map((user) => user.clerkId),
    secretKey: options.secretKey,
    schedule: options.schedule,
    spinner: options.spinner,
    label: "Checking the imported users",
  });

  const byId = new Map(found.map((user) => [user.id, user]));
  const since = Date.parse(options.since);
  const present = options.users.filter((user) => byId.has(user.clerkId));
  const gone = options.users.filter((user) => !byId.has(user.clerkId));
  const signedIn = present
    .filter((user) => {
      const lastSignIn = byId.get(user.clerkId)?.last_sign_in_at;
      return typeof lastSignIn === "number" && lastSignIn > since;
    })
    .map((user) => user.clerkId);

  return { present, gone, signedIn };
}

export type UndoSummary = {
  deleted: number;
  failed: number;
  errorBreakdown: Map<string, number>;
};

/** Deletes each user, rate-limited and 429-retried exactly as the import is. */
async function deleteUsers(options: {
  users: UndoUser[];
  secretKey: string;
  limits: ResolvedLimits;
  run: Run;
  progress?: ProgressUpdate;
}): Promise<UndoSummary> {
  const { users, secretKey, limits, run, progress: report } = options;
  const schedule = createApiScheduler(limits.concurrencyLimit, limits.rateLimit);
  const errorBreakdown = new Map<string, number>();
  let processed = 0;
  let deleted = 0;
  let failed = 0;

  const progress = () => report?.({ done: processed, ok: deleted, failed });

  // A failure on one user must not stop the rest: a half-undone import with
  // no record of which half is far worse than a reported failure.
  const deleteOne = async (user: UndoUser): Promise<void> => {
    const retries: string[] = [];
    try {
      await retryOn429(
        async () =>
          schedule(async () =>
            bapiRequest({ method: "DELETE", path: `/v1/users/${user.clerkId}`, secretKey }),
          ),
        {
          // A 429 pauses every delete still queued, as on import.
          onRetry: ({ message, delaySeconds }) => {
            retries.push(message);
            schedule.pause(delaySeconds * 1000);
          },
        },
      );
      deleted++;
      run.append({
        sourceId: user.sourceId,
        clerkId: user.clerkId,
        status: "deleted",
        ...(retries.length > 0 ? { error: retries.join("; ") } : {}),
      });
    } catch (error) {
      // Gone already, by the dashboard or another undo: the goal is met.
      if (error instanceof BapiError && error.status === 404) {
        deleted++;
        run.append({
          sourceId: user.sourceId,
          clerkId: user.clerkId,
          status: "deleted",
          reason: "already deleted",
        });
      } else {
        failed++;
        const { message, code } = failureOf(error);
        tallyError(errorBreakdown, message);
        run.append({
          sourceId: user.sourceId,
          clerkId: user.clerkId,
          status: "failed",
          error: [message, ...retries].join("; "),
          code,
        });
      }
    }
    processed++;
    progress();
  };

  progress();
  await Promise.all(users.map(deleteOne));
  return { deleted, failed, errorBreakdown };
}

function printPreview(record: RunRecord, preview: UndoPreview): void {
  const are = (count: number) => (count === 1 ? "is" : "are");
  log.blank();
  log.info(
    `${bold(`Will delete ${plural(preview.toDelete, "user")}`)} created by import run ${record.id}.`,
  );
  if (preview.signedInSince > 0) {
    const who =
      preview.signedInSince === 1 ? "1 of them has" : `${preview.signedInSince} of them have`;
    log.warn(`${who} signed in since the import. Deleting removes their accounts and sessions.`);
  }
  if (preview.alreadyGone > 0) {
    log.info(
      dim(
        `${plural(preview.alreadyGone, "user")} the import created ${are(preview.alreadyGone)} already gone.`,
      ),
    );
  }
  if (preview.alreadyDeleted > 0) {
    log.info(
      dim(
        `${plural(preview.alreadyDeleted, "user")} ${preview.alreadyDeleted === 1 ? "was" : "were"} deleted by an earlier attempt.`,
      ),
    );
  }
}

/**
 * The JSON every outcome prints. `import` is the run being undone; `run` is the
 * undo's own run, null until one is written, as an import's is.
 */
/**
 * What the JSON adds to the preview: why undo stopped before deleting, or,
 * once it did, its run and result. One of these, never two.
 */
type UndoOutcome =
  | { dryRun: true }
  | { consent: "required" }
  | { changed: true; signedInSincePreview?: number }
  | { recheckFailed: true }
  | { writeFailed: true }
  | { stopped: true }
  | {
      run: RunRecord;
      result: { deleted: number; failed: number; errors: { error: string; count: number }[] };
    };

function jsonResult(
  target: ClerkTarget,
  record: RunRecord,
  preview: UndoPreview,
  extra: UndoOutcome,
) {
  return { target, import: record, run: null, preview, ...extra };
}

export async function undo(runId: string, options: UndoOptions = {}): Promise<void> {
  const runsDir = await resolveRunsDir(options.runsDir);
  const record = readImportRun(runsDir, runId);
  const importLines = readUserLines(runsDir, record.id).length;
  // The command a hint suggests, reaching the same runs folder and instance.
  const undoAgain = undoCommand(record.id, carryFlags(options));

  const { secretKey, target } = await resolveClerkTarget(options);
  if (!options.json) printTarget(target);
  assertSameInstance(record, target, secretKey);

  const limits = resolveLimits(secretKey);
  const openUndo = openUndoOf(runsDir, record.id);
  const undoLines = openUndo ? readUserLines(runsDir, openUndo.id).length : 0;
  const recorded = usersToDelete(runsDir, record, openUndo);
  const { alreadyDeleted } = recorded;

  const schedule = createApiScheduler(limits.concurrencyLimit, limits.rateLimit);
  const users = [
    ...recorded.users,
    ...(await findInFlight({
      runId: record.id,
      sourceIds: recorded.unconfirmed,
      secretKey,
      schedule,
    })),
  ];
  const { present, gone, signedIn } =
    users.length > 0
      ? await withSpinner("Checking the imported users...", async (spinner) =>
          inspectUsers({ users, since: record.startedAt, secretKey, schedule, spinner }),
        )
      : { present: [], gone: [], signedIn: [] };

  const preview: UndoPreview = {
    toDelete: present.length,
    signedInSince: signedIn.length,
    alreadyGone: gone.length,
    alreadyDeleted,
  };

  if (!options.json) printPreview(record, preview);

  // The flags that found this run and instance, or the command looks elsewhere
  // and refuses.
  const command = [
    `clerk migrate undo ${record.id} --yes`,
    ...(preview.signedInSince > 0 ? ["--include-signed-in"] : []),
    ...carryFlags(options),
    ...(options.json ? ["--json"] : []),
  ].join(" ");
  const nothingLeft = present.length === 0 && gone.length === 0;

  if (options.dryRun) {
    if (options.json) {
      log.data(JSON.stringify(jsonResult(target, record, preview, { dryRun: true }), null, 2));
    } else {
      log.blank();
      log.info(dim(`Dry run: nothing was deleted. Run \`${command}\` to delete them.`));
    }
    return;
  }

  // After the preview, --json prints its object exactly once, whatever
  // happens: the result, a refusal with its marker, or, for anything else
  // that stops the undo, the preview marked `writeFailed` (the file system
  // refused) or `stopped`. The reason goes to stderr as for any error.
  let printed = false;
  const printJsonPreview = (extra: UndoOutcome) => {
    if (!options.json || printed) return;
    printed = true;
    log.data(JSON.stringify(jsonResult(target, record, preview, extra), null, 2));
  };
  // Rule 1: nothing is deleted without consent — `--yes`, or a yes at a
  // prompt. `--json` never prompts.
  if (!nothingLeft && !options.yes) {
    const canAsk = !options.json && isHuman() && !isAgent() && terminal.available();
    if (!canAsk) {
      printJsonPreview({ consent: "required" });
      throwUsageError(
        `\`clerk migrate undo\` permanently deletes ${plural(present.length, "user")} and needs consent. Pass --yes to confirm.`,
        undefined,
        undefined,
        [{ command, description: "Delete the users this import created" }],
      );
    }
    const proceed = await confirm({
      message: `Permanently delete ${plural(present.length, "user")}?`,
      default: false,
    });
    if (!proceed) throwUserAbort();
  }

  // Rule 2: `--yes` consents to undoing the import, not to deleting accounts
  // people have used since. That takes its own flag; a human at the prompt has
  // the warning above.
  if (options.yes && preview.signedInSince > 0 && !options.includeSignedIn) {
    printJsonPreview({ consent: "required" });
    throwUsageError(
      `${plural(preview.signedInSince, "user")} the import created ${preview.signedInSince === 1 ? "has" : "have"} signed in since, and --yes alone does not delete them. ` +
        "Pass --include-signed-in to delete them too. Nothing was deleted.",
      undefined,
      undefined,
      [{ command, description: "Delete every user this import created" }],
    );
  }

  const refuseChanged = (message: string, extra: { signedInSincePreview?: number } = {}): never => {
    printJsonPreview({ changed: true, ...extra });
    throwUsageError(message);
  };

  try {
    await deleteAfterPreview();
  } catch (error) {
    printJsonPreview(isFileSystemError(error) ? { writeFailed: true } : { stopped: true });
    throw error;
  }

  async function deleteAfterPreview(): Promise<void> {
    // Gitignored only now, once there is consent to write a run.
    await resolveRunsDir(options.runsDir, { write: true });

    // Held until the import is marked undone, so a re-import cannot continue
    // the run while its users are deleted and overwrite the `undone` mark.
    let releaseImport: () => void;
    try {
      releaseImport = lockRun(runsDir, record.id);
    } catch (error) {
      if (error instanceof CliError) refuseChanged(error.message);
      throw error;
    }
    let run: Run;
    let summary: UndoSummary;
    let undoRecord: RunRecord;
    let importRecord = record;
    try {
      // Another undo that finished during the preview has already marked it.
      try {
        readImportRun(runsDir, record.id);
      } catch (error) {
        if (error instanceof CliError) refuseChanged(error.message);
        throw error;
      }
      // A re-import that continued the run during the preview created users
      // the preview never listed. Another undo that started or carried on an
      // undo run in the meantime changed which users are left to delete, and a
      // second undo run would split the import's deletes between the two.
      const openNow = openUndoOf(runsDir, record.id);
      if (
        readUserLines(runsDir, record.id).length !== importLines ||
        openNow?.id !== openUndo?.id ||
        (openUndo !== undefined && readUserLines(runsDir, openUndo.id).length !== undoLines)
      ) {
        refuseChanged(
          `Run ${record.id} changed while this undo was waiting, so the preview is out of date. ` +
            `Nothing was deleted. Run \`${undoAgain}\` again.`,
        );
      }

      // A user who signed in after the preview is one nobody agreed to delete:
      // --yes covered the preview's users, and so did a yes at the prompt. By
      // ID, not count: one the preview showed can leave as another signs in.
      if (present.length > 0 && !options.includeSignedIn) {
        let now: Awaited<ReturnType<typeof inspectUsers>>;
        try {
          now = await inspectUsers({
            users: present,
            since: record.startedAt,
            secretKey,
            schedule,
          });
        } catch (error) {
          printJsonPreview({ recheckFailed: true });
          throw error;
        }
        const seen = new Set(signedIn);
        const more = now.signedIn.filter((clerkId) => !seen.has(clerkId)).length;
        if (more > 0) {
          refuseChanged(
            `${plural(more, "more user")} the import created signed in after the preview, and nothing agreed to delete them. Nothing was deleted.\n` +
              `Run \`${undoAgain}\` again to see them, or pass --include-signed-in to delete them too.`,
            { signedInSincePreview: more },
          );
        }
      }

      run = openUndo
        ? continueRun(runsDir, openUndo)
        : startRun(runsDir, { kind: "undo", target, undoes: record.id, source: record.source });

      // Users the import created that are no longer there: the undo's goal for
      // them is already met, so they count as deleted without another request.
      for (const user of gone) {
        run.append({ ...user, status: "deleted", reason: "not found in the instance" });
      }

      summary =
        present.length > 0
          ? await withProgress({ total: present.length, verb: "deleted" }, async (progress) =>
              deleteUsers({ users: present, secretKey, limits, run, progress }),
            )
          : { deleted: 0, failed: 0, errorBreakdown: new Map<string, number>() };

      // A Ctrl-C rejects every delete still queued. Left unfinished, the undo
      // reads as interrupted, as an import does.
      if (interruptedExitCode() !== null) {
        run.release();
        throwUserAbort();
      }
      undoRecord = run.finish();
      if (undoRecord.status === "complete") {
        importRecord =
          patchRun(runsDir, record.id, { status: "undone", undoneBy: undoRecord.id }) ?? record;
      }
    } finally {
      releaseImport();
    }

    if (options.json) {
      printed = true;
      log.data(
        JSON.stringify(
          jsonResult(target, importRecord, preview, {
            run: undoRecord,
            result: {
              deleted: summary.deleted,
              failed: summary.failed,
              errors: [...summary.errorBreakdown].map(([error, count]) => ({ error, count })),
            },
          }),
          null,
          2,
        ),
      );
    } else {
      log.blank();
      log.info(`${bold("Deleted:")} ${green(String(summary.deleted))}`);
      log.info(`${bold("Failed:")} ${red(String(summary.failed))}`);
      for (const [error, count] of summary.errorBreakdown) {
        log.info(`  ${plural(count, "user")}: ${error}`);
      }
      log.blank();
      log.info(dim(`Undo run ${undoRecord.id}: ${run.dir}`));
      if (undoRecord.status === "complete") {
        log.success(`Import run ${record.id} is undone.`);
      } else {
        log.info(`Run \`${undoAgain}\` again to retry the users that failed.`);
      }
    }

    if (undoRecord.status !== "complete") process.exitCode = 1;
  }
}

/** An error the file system raised (EACCES, ENOSPC, …), rather than the API or the user. */
function isFileSystemError(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return typeof code === "string" && typeof errno === "number";
}
