/**
 * `clerk migrate import <file>` — the user import itself.
 *
 * Registered as the `import` subcommand. The exported handler keeps the name
 * `run` because `import` is a reserved word.
 *
 * An import goes through the same steps every time:
 *
 * 1. Settle the file, the source and the target instance, and print the target.
 * 2. Load the users: read the file, map it through the source, then normalize
 *    and validate it.
 * 3. Run `checkImport()` against the real instance. `--dry-run` stops here.
 * 4. Refuse on any reject unless `--allow-partial`, then ask for consent.
 *    Nothing is written without `--yes` or a yes at the prompt.
 * 5. Import, one run line per user.
 */

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
import { DEV_USER_LIMIT, resolveLimits, type InstanceType } from "./lib/instance.ts";
import { resolveRunsDir, sha256File, startRun, type Run, type RunRecord } from "./lib/run-store.ts";
import { withProgress } from "./lib/progress.ts";
import { createApiScheduler } from "./lib/scheduler.ts";
import { readSupabaseRows } from "./lib/supabase-providers.ts";
import { printTarget, resolveClerkTarget } from "./lib/target.ts";
import {
  fileExists,
  getFileType,
  loadUsersFromFile,
  resolveImportFilePath,
} from "./lib/transform.ts";
import { resolveSource, sourceKeys } from "./sources/registry.ts";
import type { ImportSummary, User } from "./types.ts";
import { promptForFile, promptForSource } from "./wizard.ts";
import { login } from "../auth/login.ts";
import { link } from "../link/index.ts";

export type MigrateRunOptions = {
  /** The export file. */
  input?: string;
  /** A built-in source key. */
  source?: string;
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
  yes?: boolean;
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Nobody can answer a prompt: an agent, a non-TTY run, or `--json`. */
function canPrompt(options: MigrateRunOptions): boolean {
  return !options.json && isHuman() && !isAgent();
}

/**
 * Validates what a run needs before anything is read or sent.
 *
 * `--source` has already been resolved to a registered key by the time this
 * runs.
 *
 * @returns The source key and file path, both guaranteed present.
 */
export function validateRunOptions(options: MigrateRunOptions): {
  source: string;
  file: string;
} {
  if (!options.source) {
    throwUsageError(
      `Missing --source. Valid values: ${sourceKeys().join(", ")}.`,
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
      "Missing the file to import (a JSON or CSV export).",
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
 * that production does not have at all — so "contact support", which both
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
  // and no linked directory involved — mirroring resolveBapiSecretKey.
  if (options.secretKey || process.env.CLERK_SECRET_KEY) return;
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
 * Settles which file to read. A human who gave none is asked for a path.
 */
async function resolveInput(options: MigrateRunOptions): Promise<string> {
  if (options.input) return options.input;
  if (!canPrompt(options)) {
    throwUsageError(
      "`clerk migrate import` needs the file to import, and cannot prompt here.",
      undefined,
      undefined,
      [
        {
          command: "clerk migrate import users.json --source clerk --yes",
          description: "Import a file",
        },
      ],
    );
  }
  return promptForFile();
}

/**
 * Resolves `--source` to a registered key.
 *
 * @throws UsageError for an unknown key.
 */
async function applySource(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  if (!options.source) return options;
  const resolved = await resolveSource(options.source);
  return { ...options, source: resolved.key };
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

// --- The import ------------------------------------------------------------

/**
 * The exact command that would carry on from here, for the consent and
 * refusal messages. Every value is shell-quoted; secrets are placeholders.
 */
function commandFor(options: MigrateRunOptions, extra: string[]) {
  const input = options.input ?? options.file ?? "<file>";
  const parts = ["clerk migrate import", quoteArg(input)];
  if (options.source) parts.push("--source", quoteArg(options.source));
  if (options.allowPartial) parts.push("--allow-partial");
  if (options.requirePassword) parts.push("--require-password");
  if (options.skipLegalChecks) parts.push("--skip-legal-checks");
  if (options.secretKey) parts.push("--secret-key", "<key>");
  if (options.app) parts.push("--app", quoteArg(options.app));
  if (options.instance) parts.push("--instance", quoteArg(options.instance));
  if (options.runsDir) parts.push("--runs-dir", quoteArg(options.runsDir));
  if (options.json) parts.push("--json");
  return [...parts, ...extra].join(" ");
}

/** Records the checks' rejects as skipped users, so the run says who they were. */
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
  await ensureImportTarget(rawOptions);
  let options = await applySource(rawOptions);

  const input = await resolveInput(options);
  options = { ...options, file: input };

  if (!options.source && canPrompt(options) && fileExists(input)) {
    options = { ...options, source: await promptForSource() };
  }

  const { source, file } = validateRunOptions(options);

  await withGutter(
    "Migrating users to Clerk",
    async ({ setNextSteps }) => {
      const { secretKey, target } = await resolveClerkTarget(options);
      if (!options.json) printTarget(target);
      const limits = resolveLimits(secretKey);

      const filePath = resolveImportFilePath(file);
      const sha256 = sha256File(filePath);
      const runsDir = await resolveRunsDir(options.runsDir);
      const schedule = createApiScheduler(limits.concurrencyLimit, limits.rateLimit);

      const loaded = await withSpinner(`Loading users from ${file}...`, async () =>
        loadUsersFromFile(file, source),
      );
      let users = loaded.users;

      // An instruction about this import, not a prediction: users without a
      // password are left out of the job rather than recorded as rejects.
      let withoutPassword: User[] = [];
      if (options.requirePassword) {
        withoutPassword = users.filter((user) => !user.password);
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
          failures: loaded.failures,
          unknownFields: loaded.unknownFields,
          ...(supabaseRows ? { supabaseRows } : {}),
          settings,
          existingUsers,
          instanceType: limits.instanceType,
          target,
          secretKey,
          schedule,
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
            { target, run: null, checks: checksJson(checks), ...leftOut, ...extra },
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
              command: commandFor(options, ["--allow-partial", "--yes"]),
              description: "Import the users that pass",
            },
          ],
        );
      }

      if (
        checks.importable.length === 0 &&
        checks.rejects.length === 0 &&
        withoutPassword.length === 0
      ) {
        if (options.json) preview({ nothingToImport: true });
        else log.warn("No users left to import.");
        return;
      }

      // Rule 1: nothing is written without consent — `--yes`, or a yes at a
      // prompt. An agent, a non-TTY run and `--json` never prompt.
      if (!options.yes) {
        if (!canPrompt(options)) {
          if (options.json) preview({ consent: "required" });
          throwUsageError(
            `\`clerk migrate import\` will create ${plural(checks.importable.length, "user")} and needs consent. Pass --yes to confirm.`,
            undefined,
            undefined,
            [
              {
                command: commandFor(options, ["--yes"]),
                description: "Run the import",
              },
            ],
          );
        }
        log.blank();
        const proceed = await confirm({
          message: `Import ${plural(checks.importable.length, "user")}?`,
          default: false,
        });
        if (!proceed) throwUserAbort();
      }

      // Gitignored only now, once there is consent to write a run.
      await resolveRunsDir(options.runsDir, { write: true });
      const run = startRun(runsDir, {
        kind: "import",
        target,
        source,
        file: { path: filePath, sha256 },
      });
      recordRejects(run, checks);
      for (const user of withoutPassword) {
        run.append({
          sourceId: user.userId,
          status: "skipped",
          reason: "no password (--require-password)",
        });
      }

      const summary: ImportSummary =
        checks.importable.length > 0
          ? await withProgress(
              { total: checks.importable.length, verb: "created" },
              async (progress) =>
                importUsers({
                  users: checks.importable,
                  secretKey,
                  limits,
                  record: run.append,
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
      // no line to count. Left unfinished, the run reads as interrupted.
      if (interruptedExitCode() !== null) {
        run.release();
        return;
      }
      const record = run.finish({ notSent: summary.notSent });
      if (summary.failed > 0) process.exitCode = 1;

      if (options.json) {
        log.data(
          JSON.stringify(
            {
              target,
              run: record,
              checks: checksJson(checks),
              ...leftOut,
              result: {
                created: summary.successful,
                failed: summary.failed,
                notSent: summary.notSent,
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

      const steps =
        summary.failed > 0
          ? NEXT_STEPS.MIGRATE_DONE_WITH_ERRORS(run.dir)
          : NEXT_STEPS.MIGRATE_DONE(run.dir);
      setNextSteps(steps);
      printAgentNextSteps(steps);
    },
    { skip: Boolean(options.json) },
  );
}
