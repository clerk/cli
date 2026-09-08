/**
 * `clerk migrate delete` — undo a migration.
 *
 * Ported from the standalone migration-tool's `src/delete/index.ts`, with two
 * substantive changes:
 *
 * - **Users are looked up by `external_id`, not by downloading the instance.**
 *   The original paged through every user in the instance 500 at a time and
 *   intersected client-side, which on a large instance means fetching hundreds
 *   of thousands of users to delete a few hundred. `GET /v1/users` filters on
 *   up to 100 `external_id`s per call and ignores IDs it does not find, so the
 *   work is proportional to the migration rather than to the instance.
 * - **IDs come from the existing transform pipeline.** The original
 *   re-implemented per-format ID extraction with its own Firebase CSV header
 *   list and a chain of `userId`/`user_id`/`localId`/`id` fallbacks. The
 *   transformer already declares which source field becomes `userId`.
 *
 * This is the one command in the `migrate` tree that destroys data in Clerk, so
 * it stays flat and prominent rather than buried under a noun group, and it
 * confirms before acting.
 */

import { bapiRequest } from "../../lib/bapi.ts";
import { bold, dim, green, red } from "../../lib/color.ts";
import {
  BapiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import { describeBapiTarget, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { confirm } from "../../lib/prompts.ts";
import { withGutter, withSpinner, type SpinnerControls } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { normalizeErrorMessage } from "./import-users.ts";
import { resolveLimits, type ResolvedLimits } from "./lib/instance.ts";
import { deleteErrorLogger, deleteLogger, getDateTimeStamp, getLogFilePath } from "./lib/logger.ts";
import { RateLimitExceededError, retryOn429 } from "./lib/retry.ts";
import { createApiScheduler } from "./lib/scheduler.ts";
import { loadSettings } from "./lib/settings.ts";
import { fileExists, readRawUsers, transformKeys } from "./lib/transform.ts";
import { getTransformer } from "./transformers/registry.ts";

/** BAPI accepts at most 100 `external_id` values per `GET /v1/users` call. */
const EXTERNAL_ID_BATCH = 100;

export type MigrateDeleteOptions = {
  yes?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
};

export type MigratedUser = {
  /** The Clerk user ID to delete. */
  id: string;
  /** The source platform's ID, stamped on the user as `external_id`. */
  externalId: string;
};

/**
 * Resolves which migration is being undone.
 *
 * The saved migration record is the only account of that — this command has no
 * independent way to know what a previous run created, which is why it is
 * coupled to `run`.
 */
export async function resolveMigrationToUndo(): Promise<{ file: string; key: string }> {
  const settings = await loadSettings();

  if (!settings.file || !settings.transformer) {
    throw new CliError(
      "No migration to undo: this project has no record of a previous `clerk migrate import`.\n" +
        "Run `clerk migrate delete` from the project you migrated from.",
      { code: ERROR_CODE.FILE_NOT_FOUND },
    );
  }

  if (!fileExists(settings.file)) {
    throw new CliError(
      `The migration file ${settings.file} is no longer there, so the users it created cannot be identified.`,
      { code: ERROR_CODE.FILE_NOT_FOUND },
    );
  }

  return { file: settings.file, key: settings.transformer };
}

/**
 * The source IDs a migration stamped onto Clerk users as `external_id`.
 *
 * Runs the transformer's field mapping but not its `postTransform`: only the
 * ID matters here, and Firebase's post-transform would demand the project's
 * password hash parameters to rebuild digests nobody is importing.
 */
export async function readMigratedExternalIds(file: string, key: string): Promise<string[]> {
  const transformer = getTransformer(key);
  const rows = await readRawUsers(file, key);

  const ids = new Set<string>();
  for (const row of rows) {
    const userId = transformKeys(row, transformer).userId;
    if (typeof userId === "string" && userId.length > 0) ids.add(userId);
  }
  return [...ids];
}

/** Splits `items` into chunks of at most `size`. */
export function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Finds the Clerk users a migration created, by `external_id`.
 *
 * IDs with no matching user are simply absent from the result — a partial
 * migration, or one already partly undone, is the normal case.
 */
export async function findMigratedUsers(options: {
  externalIds: string[];
  secretKey: string;
  spinner?: SpinnerControls;
}): Promise<MigratedUser[]> {
  const found: MigratedUser[] = [];
  const batches = batch(options.externalIds, EXTERNAL_ID_BATCH);

  for (const [index, ids] of batches.entries()) {
    options.spinner?.update(`Finding migrated users: batch ${index + 1}/${batches.length}...`);

    const params = new URLSearchParams();
    params.set("limit", String(EXTERNAL_ID_BATCH));
    for (const id of ids) params.append("external_id", id);

    const response = await retryOn429(() =>
      bapiRequest({
        method: "GET",
        path: `/v1/users?${params.toString()}`,
        secretKey: options.secretKey,
      }),
    );

    const users = (response.body ?? []) as { id?: string; external_id?: string }[];
    for (const user of Array.isArray(users) ? users : []) {
      // Never delete on a partial match: only a user Clerk itself reports as
      // carrying one of this migration's external IDs is in scope.
      if (user.id && user.external_id && ids.includes(user.external_id)) {
        found.push({ id: user.id, externalId: user.external_id });
      }
    }
  }

  return found;
}

export type DeleteSummary = {
  deleted: number;
  failed: number;
  errorBreakdown: Map<string, number>;
};

/** Deletes each user, rate-limited and 429-retried exactly as the import is. */
export async function deleteMigratedUsers(options: {
  users: MigratedUser[];
  secretKey: string;
  limits: ResolvedLimits;
  dateTime: string;
  spinner?: SpinnerControls;
}): Promise<DeleteSummary> {
  const { users, secretKey, limits, dateTime, spinner } = options;
  const schedule = createApiScheduler(limits.concurrencyLimit, limits.rateLimit);
  const errorBreakdown = new Map<string, number>();

  let processed = 0;
  let deleted = 0;
  let failed = 0;

  const progress = () =>
    spinner?.update(
      `Deleting users: [${processed}/${users.length}] (${deleted} deleted, ${failed} failed)...`,
    );

  // A failure on one user must not abort the rest: a half-undone migration
  // with no record of which half is far worse than a reported failure.
  const recordFailure = (user: MigratedUser, message: string, code: string) => {
    failed++;
    processed++;
    const normalized = normalizeErrorMessage(message);
    errorBreakdown.set(normalized, (errorBreakdown.get(normalized) ?? 0) + 1);
    deleteLogger(
      { userId: user.externalId, clerkUserId: user.id, status: "error", error: message, code },
      dateTime,
    );
    progress();
  };

  const deleteOne = async (user: MigratedUser): Promise<void> => {
    try {
      await retryOn429(
        () =>
          schedule(() =>
            bapiRequest({ method: "DELETE", path: `/v1/users/${user.id}`, secretKey }),
          ),
        {
          onRetry: ({ message }) =>
            deleteErrorLogger(
              {
                userId: user.externalId,
                status: "429_retry",
                errors: [{ code: "rate_limit_retry", message, longMessage: message }],
              },
              dateTime,
            ),
        },
      );

      deleted++;
      processed++;
      deleteLogger({ userId: user.externalId, clerkUserId: user.id, status: "success" }, dateTime);
      progress();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        recordFailure(user, error.message, "429");
        return;
      }
      const apiError = error as BapiError;
      const message = apiError.longMessage ?? apiError.message ?? "Unknown error";
      recordFailure(user, message, String(apiError.status ?? "unknown"));
    }
  };

  progress();
  await Promise.all(users.map(deleteOne));

  return { deleted, failed, errorBreakdown };
}

function formatSummary(summary: DeleteSummary, logFile: string): string {
  const lines = [
    `${bold("Deleted:")} ${green(String(summary.deleted))}`,
    `${bold("Failed:")} ${red(String(summary.failed))}`,
  ];

  if (summary.errorBreakdown.size > 0) {
    lines.push("", bold("Error breakdown:"));
    for (const [error, count] of summary.errorBreakdown) {
      lines.push(`  ${count} user${count === 1 ? "" : "s"}: ${error}`);
    }
  }
  lines.push("", dim(`Log: ${logFile}`));

  return lines.join("\n");
}

export async function deleteMigration(options: MigrateDeleteOptions): Promise<void> {
  const { file, key } = await resolveMigrationToUndo();

  await withGutter("Undoing a migration", async ({ setNextSteps }) => {
    const target = await describeBapiTarget({ ...options, secretKey: options.secretKey });
    const secretKey = await resolveBapiSecretKey({ ...options, secretKey: options.secretKey });
    const limits = resolveLimits(secretKey);
    const dateTime = getDateTimeStamp();
    const logFile = getLogFilePath("delete", dateTime);

    const externalIds = await readMigratedExternalIds(file, key);
    if (externalIds.length === 0) {
      log.warn(`No user IDs found in ${file}; nothing to undo.`);
      return;
    }

    const users = await withSpinner("Finding migrated users...", (spinner) =>
      findMigratedUsers({ externalIds, secretKey, spinner }),
    );

    if (users.length === 0) {
      log.info(
        `None of the ${externalIds.length} user${externalIds.length === 1 ? "" : "s"} in ${file} are in ${target ?? "this instance"}. Nothing to delete.`,
      );
      return;
    }

    log.warn(
      `About to delete ${users.length} user${users.length === 1 ? "" : "s"} from ` +
        `${target ?? "the resolved instance"}, matched to ${file} by external ID.`,
    );
    if (users.length < externalIds.length) {
      log.info(
        dim(
          `${externalIds.length - users.length} of the file's users ${externalIds.length - users.length === 1 ? "is" : "are"} not in this instance and will be left alone.`,
        ),
      );
    }

    if (!options.yes) {
      if (isAgent() || !isHuman()) {
        throwUsageError(
          `\`clerk migrate delete\` permanently deletes ${users.length} user${users.length === 1 ? "" : "s"} and cannot prompt here. Pass -y to confirm.`,
          undefined,
          undefined,
          [
            {
              command: "clerk migrate delete -y",
              description: "Delete the migrated users without prompting",
            },
          ],
        );
      }

      const proceed = await confirm({
        message: `Permanently delete ${users.length} user${users.length === 1 ? "" : "s"}?`,
        default: false,
      });
      if (!proceed) throwUserAbort();
    }

    const summary = await withSpinner(`Deleting users: [0/${users.length}]...`, (spinner) =>
      deleteMigratedUsers({ users, secretKey, limits, dateTime, spinner }),
    );

    log.info(formatSummary(summary, logFile));

    setNextSteps(NEXT_STEPS.MIGRATE_DELETE);

    if (summary.failed > 0) process.exitCode = 1;
  });
}
