/**
 * `clerk migrate import` — the user import itself.
 *
 * Ported from the standalone migration-tool's `src/migrate/cli.ts`
 * (`runNonInteractive`), with auth moved onto the CLI's standard secret-key
 * resolution chain and every failure raised as a `CliError` instead of
 * `console.error` + `process.exit`.
 *
 * Registered as the `import` subcommand. The exported handler keeps the name
 * `run` because `import` is a reserved word. Whatever the flags did not supply
 * is filled in by `wizard.ts` for a human, or raised as a usage error naming
 * the missing flags for an agent, which cannot answer a prompt.
 */

import { bold, dim, green, red, yellow } from "../../lib/color.ts";
import { resolveProfile } from "../../lib/config.ts";
import path from "node:path";
import { hasAccountCredentials } from "../../lib/credential-store.ts";
import {
  AUTH_ERROR_REASON,
  AuthError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import {
  resolveInstanceTarget,
  resolveKeylessTarget,
  type InstanceTarget,
} from "../../lib/keyless-target.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS, printAgentNextSteps } from "../../lib/next-steps.ts";
import { confirm, multiselect } from "../../lib/prompts.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { writeInstanceConfig } from "../config/io.ts";
import { importUsers } from "./import-users.ts";
import { analyzeFields } from "./lib/analysis.ts";
import { resolveFirebaseHashConfig, type FirebaseHashFlags } from "./lib/firebase-hash.ts";
import {
  enabledSocialProviders,
  fetchInstanceSettings,
  fetchUserCount,
  toClerkStrategy,
} from "./lib/clerk-config.ts";
import {
  buildReadinessReport,
  DASHBOARD_URL,
  formatReadinessReport,
  type ReadinessReport,
} from "./lib/readiness.ts";
import {
  applyChanges,
  buildChangePayload,
  buildSettingChanges,
  type SettingChange,
} from "./lib/modify-settings.ts";
import { DEV_USER_LIMIT, resolveLimits, type InstanceType } from "./lib/instance.ts";
import { readEnvelope, type ExportEnvelope } from "./lib/export-file.ts";
import {
  readRun,
  resolveRunsDir,
  RUN_ID_PATTERN,
  sha256File,
  startRun,
  type RunRecord,
} from "./lib/run-store.ts";
import {
  countSocialProviders,
  findDisabledProviders,
  findUsersWithOnlyDisabledProviders,
  readSupabaseRows,
} from "./lib/supabase-providers.ts";
import { describeTarget, resolveClerkTarget } from "./lib/target.ts";
import {
  fileExists,
  getFileType,
  loadUsersFromFile,
  resolveImportFilePath,
} from "./lib/transform.ts";
import { resolveSource, sourceKeys } from "./sources/registry.ts";
import type { ImportSummary, User } from "./types.ts";
import { runWizard, throwAgentFlagsRequired } from "./wizard.ts";
import { login } from "../auth/login.ts";
import { link } from "../link/index.ts";

export type MigrateRunOptions = {
  /** An export file, or the ID of the export run that wrote one. */
  input?: string;
  /** A built-in source key, or the path to a source you wrote. */
  source?: string;
  /** Content hash of a custom `--source`, set once it is loaded. */
  sourceHash?: string;
  file?: string;
  resumeAfter?: string;
  requirePassword?: boolean;
  yes?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  /** Supabase: drop users whose only social provider is disabled in Clerk. */
  skipUnsupportedProviders?: boolean;
  /** Where runs are kept; overrides `CLERK_MIGRATE_DIR`. */
  runsDir?: string;
} & FirebaseHashFlags;

/**
 * Validates the flags a run needs before anything is read or sent.
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
          command: "clerk migrate import users.json --source clerk -y",
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
          command: "clerk migrate import users.json --source clerk -y",
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

/**
 * Drops every user up to and including `resumeAfter`.
 *
 * @throws CliError when the ID is not in the file — silently importing the
 *   whole set would duplicate everything the previous run already created.
 */
export function applyResumeAfter(users: User[], resumeAfter: string | undefined): User[] {
  if (!resumeAfter) return users;

  const index = users.findIndex((user) => user.userId === resumeAfter);
  if (index === -1) {
    throw new CliError(`Could not find user ID "${resumeAfter}" in the import file.`, {
      code: ERROR_CODE.USAGE_ERROR,
    });
  }
  return users.slice(index + 1);
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

function formatSummary(
  summary: ImportSummary,
  run: RunRecord,
  runFolder: string,
  instanceType: InstanceType,
): string {
  const inFile = summary.totalProcessed + summary.validationFailed;
  const lines = [
    `${bold("Total users in file:")} ${inFile}`,
    `${green("Imported:")} ${summary.successful}`,
    `${red("Failed:")} ${summary.failed}`,
  ];

  if (summary.validationFailed > 0) {
    lines.push(`${yellow("Failed validation:")} ${summary.validationFailed}`);
  }
  if (summary.errorBreakdown.size > 0) {
    lines.push("", bold("Error breakdown:"));
    for (const [error, count] of summary.errorBreakdown) {
      lines.push(`  ${count} user${count === 1 ? "" : "s"}: ${error}`);
    }
    for (const note of explainErrors(summary.errorBreakdown.keys(), instanceType)) {
      lines.push("", note);
    }
  }
  lines.push("", dim(`Run ${run.id}: ${runFolder}`));

  return lines.join("\n");
}

/**
 * Stops an import that looks likely to exhaust a development instance's user
 * quota, and asks before letting it through anyway.
 *
 * A prompt rather than a hard refusal, because the number it checks against
 * cannot be trusted to be this instance's: {@link DEV_USER_LIMIT} is only what
 * an instance is *created* with, Clerk raises it per instance on request, and
 * no public endpoint serves the real value. The existing user count is live;
 * the limit it is measured against is not. Refusing outright would block
 * imports the destination would happily accept, so the operator — who can ask
 * Clerk what their limit is — gets the last word.
 *
 * `-y` and agent mode proceed on the warning alone, matching the import
 * confirmation below: neither has anyone to answer the question.
 *
 * @returns How many of `incoming` the quota is expected to reject, or `0` when
 *   the whole file fits. The final import prompt reports the same split, so
 *   that "yes" is never a bigger number than the instance will accept.
 * @throws UserAbortError when the operator declines.
 */
async function confirmDevUserLimit(
  incoming: number,
  secretKey: string,
  yes: boolean,
): Promise<number> {
  const existing = await withSpinner("Checking the instance's user count...", async () =>
    fetchUserCount(secretKey),
  );
  const headroom = Math.max(0, DEV_USER_LIMIT - (existing ?? 0));
  if (incoming <= headroom) return 0;

  const rejected = incoming - headroom;
  const held = existing === null ? "" : `, and this one already holds ${existing}`;
  log.warn(
    `Development instances default to a ${DEV_USER_LIMIT}-user limit${held}. About ${rejected} of the ` +
      `${incoming} user${incoming === 1 ? "" : "s"} in this file will be rejected with a quota error unless ` +
      `Clerk has raised this instance's limit — the limit itself is not readable from the API.\n` +
      `Import into a production instance to bring everyone across, or contact support to raise the limit.`,
  );

  if (yes || !isHuman() || isAgent()) return rejected;

  const proceed = await confirm({
    message: `Continue anyway, expecting about ${rejected} user${rejected === 1 ? "" : "s"} to be rejected?`,
    default: false,
  });
  if (!proceed) throwUserAbort();

  return rejected;
}

/**
 * Drops users whose only way into Clerk is a social provider the destination
 * instance has not enabled.
 *
 * Only meaningful for Supabase exports — it is the one platform whose export
 * records per-user providers. If the instance's configuration cannot be read,
 * nobody is dropped: a failed lookup must not be mistaken for "no providers
 * are enabled".
 *
 * @returns The source IDs to skip.
 */
async function findDisabledProviderUsers(
  file: string,
  source: string,
  secretKey: string,
): Promise<Set<string>> {
  const none = new Set<string>();
  if (source !== "supabase") {
    log.warn(`--skip-unsupported-providers only applies to supabase exports; ignoring.`);
    return none;
  }

  const settings = await withSpinner("Checking enabled providers...", async () =>
    fetchInstanceSettings(secretKey),
  );
  const enabled = settings ? enabledSocialProviders(settings) : null;
  if (!enabled) {
    log.warn(
      "Could not read the instance's enabled providers; importing every user. Re-run with --verbose for details.",
    );
    return none;
  }

  const rows = await readSupabaseRows(file);
  const disabled = findDisabledProviders(rows, enabled, toClerkStrategy);
  if (disabled.length === 0) {
    log.info("Every provider in this export is enabled in Clerk; no users skipped.");
    return none;
  }

  const { excludedIds, byProvider } = findUsersWithOnlyDisabledProviders(rows, disabled);
  if (excludedIds.size === 0) {
    log.info(
      `${disabled.join(", ")} not enabled in Clerk, but every user has another way to sign in; none skipped.`,
    );
    return none;
  }

  const breakdown = Object.entries(byProvider)
    .map(([provider, count]) => `${provider}: ${count}`)
    .join(", ");
  log.warn(
    `--skip-unsupported-providers: skipping ${excludedIds.size} user${excludedIds.size === 1 ? "" : "s"} whose only provider is not enabled in Clerk (${breakdown}).`,
  );

  return excludedIds;
}

type ReportInput = {
  users: User[];
  file: string;
  source: string;
  secretKey: string;
  validationFailed: number;
};

/**
 * Everything the report needs except the instance's settings — the half that
 * comes from the file, and so does not change when the instance does.
 */
async function readFileSide(input: ReportInput) {
  // Only Supabase exports record per-user providers, so only they can be
  // cross-referenced against the instance's social connections.
  let providerCounts: Record<string, number> | undefined;
  if (input.source === "supabase") {
    try {
      providerCounts = countSocialProviders(await readSupabaseRows(input.file));
    } catch (error) {
      log.debug(`migrate: could not read providers for the readiness report: ${String(error)}`);
    }
  }

  return {
    analysis: analyzeFields(input.users),
    validationFailed: input.validationFailed,
    providerCounts,
  };
}

function printReport(report: ReadinessReport): void {
  log.blank();
  for (const line of formatReadinessReport(report)) log.info(line);
  log.blank();
}

/**
 * Offers to change the instance's settings, one selectable change per flagged
 * row.
 *
 * Without this the report names something the operator has to leave the CLI to
 * act on. Nothing is preselected and selecting nothing continues to the import
 * prompt unchanged: a flagged setting is not a wrong setting, and relaxing an
 * instance's sign-up requirements is a real decision rather than a default.
 *
 * @returns The changes that were written, so the caller can redraw the report.
 */
async function offerSettingChanges(
  report: ReadinessReport,
  options: MigrateRunOptions,
): Promise<SettingChange[]> {
  const changes = buildSettingChanges(report.blocking);
  if (changes.length === 0) return [];

  // Navigation keys are in the prompt's own footer; what that footer cannot say
  // is that selecting nothing is a valid answer rather than an unfinished one.
  const chosen = await multiselect<string>({
    message: "Update this instance's settings first? (enter to skip)",
    options: changes.map((change) => ({ value: change.id, label: change.label })),
    initialValues: [],
    required: false,
  });
  // Filtered before anything is resolved or sent: a selection that matches no
  // offered change is the same as no selection, and must not become an empty
  // PATCH.
  const applied = changes.filter((change) => chosen.includes(change.id));
  if (applied.length === 0) return [];

  // Resolved here rather than up front: an operator who selects nothing should
  // not pay for a Platform API round-trip, and a target that cannot be resolved
  // (a bare `--secret-key` against an unlinked directory) should not fail the
  // whole run before the report has even been offered.
  let target: InstanceTarget;
  try {
    target = await resolveInstanceTarget({ app: options.app, instance: options.instance });
  } catch (error) {
    log.warn(
      "Could not resolve which instance to configure, so nothing was changed. " +
        "Link a project with `clerk link`, or pass `--app <app_id>`.",
    );
    log.debug(`migrate: settings change target unresolved: ${String(error)}`);
    return [];
  }

  // The Backend API a keyless application is reachable through has no route for
  // any of these settings — `config patch` rejects the same payload by name.
  if (target.kind === "keyless") {
    log.warn(
      "These settings need an account to change. Run `clerk auth login` to claim this application, " +
        `then re-run, or update them at ${DASHBOARD_URL}.`,
    );
    return [];
  }

  await withSpinner(`Updating settings on ${target.label}...`, async () =>
    writeInstanceConfig(target, buildChangePayload(applied), {
      method: "PATCH",
      failureContext: "Failed to update instance settings",
    }),
  );
  log.success(`Updated ${applied.length} setting${applied.length === 1 ? "" : "s"}.`);

  return applied;
}

/**
 * Prints the Migration Readiness report: what the file contains, cross-
 * referenced against what the destination instance accepts.
 *
 * Rendered immediately before the confirmation prompt, so declining that
 * prompt aborts with nothing written to Clerk.
 *
 * Skipped only for `-y`, which says "don't ask, don't lecture" and should not
 * pay for two extra network round-trips. Agent mode still gets it: an agent
 * driving a migration can act on "10 users will not be imported, because email
 * is required" exactly as a human would — but not the prompt, which needs one.
 */
async function showReadinessReport(
  input: ReportInput & { skipReport: boolean; options: MigrateRunOptions },
): Promise<void> {
  if (input.skipReport) return;

  let settings = await withSpinner("Checking instance settings...", async () =>
    fetchInstanceSettings(input.secretKey),
  );
  const fileSide = { ...(await readFileSide(input)), users: input.users };

  let report = buildReadinessReport({ ...fileSide, settings });
  printReport(report);

  if (!isHuman() || isAgent()) return;

  // Every redraw is another decision point, not a receipt. Applying one change
  // routinely leaves others still worth making — and can surface consequences
  // that were masked behind the row just cleared — so the offer repeats for as
  // long as the report has something to offer.
  while (report.blocking.length > 0) {
    const applied = await offerSettingChanges(report, input.options);
    // Nothing selected, nothing offerable, or nowhere to write it: the operator
    // has said their piece and the import prompt is next.
    if (applied.length === 0) return;

    // Redrawn from the write, not from a re-read. Clerk's Frontend API is
    // eventually consistent, so fetching settings again here routinely returns
    // the pre-write ones and redraws every row the operator just cleared.
    settings = applyChanges(settings, applied);
    report = buildReadinessReport({ ...fileSide, settings });
    printReport(report);
  }
}

/**
 * Fills in a missing `--source`/file interactively, or explains what
 * to pass.
 *
 * Agent mode is the CLI's existing non-interactive signal, so an agent that
 * runs bare `clerk migrate import` gets a usage error naming the flags rather than a
 * prompt it cannot answer.
 */
async function resolveMissingOptions(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  const missing = { source: !options.source, file: !options.file };
  if (!missing.source && !missing.file) return options;

  if (isAgent() || !isHuman()) {
    throwAgentFlagsRequired(missing);
  }

  // Resolved before the prompt only when `--source firebase` was already
  // passed; otherwise the wizard picks the platform first and looks them up
  // itself, so a non-Firebase migration never reads them at all.
  const firebaseHashConfig = resolveFirebaseHashConfig(options, options.source);
  const answers = await runWizard({ ...options, firebaseHashConfig });

  return {
    ...options,
    source: answers.source,
    file: answers.file,
    ...(answers.firebaseHashConfig
      ? {
          firebaseSignerKey: answers.firebaseHashConfig.base64_signer_key,
          firebaseSaltSeparator: answers.firebaseHashConfig.base64_salt_separator,
          firebaseRounds: answers.firebaseHashConfig.rounds,
          firebaseMemCost: answers.firebaseHashConfig.mem_cost,
        }
      : {}),
  };
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
  if (resolved.path) {
    log.info(`Loaded the \`${resolved.key}\` source from ${options.source}.`);
  }
  return {
    ...options,
    source: resolved.key,
    ...(resolved.hash ? { sourceHash: resolved.hash } : {}),
  };
}

/**
 * Makes sure there is somewhere to import *into* before anything else happens.
 *
 * Without this the first complaint comes from deep inside the secret-key chain,
 * which resolves the linked profile before it ever asks for a token — so a
 * signed-out operator in an unlinked directory is told to `clerk link`, a
 * command that will only turn around and ask them to sign in. Worse, both
 * failures land after the wizard has already walked them through picking a
 * platform and a file.
 *
 * A human gets the same sign-in-then-link flow `clerk link` already runs. An
 * agent cannot answer a browser login or an application picker, so it gets the
 * error naming whichever half is missing.
 */
async function ensureImportTarget(options: MigrateRunOptions): Promise<void> {
  // Each of these names the destination instance on its own, with no account
  // and no linked directory involved — mirroring resolveBapiSecretKey.
  if (options.secretKey || options.app || process.env.CLERK_SECRET_KEY) return;
  // An unclaimed accountless application keeps its only secret key on disk.
  if (await resolveKeylessTarget({ instance: options.instance })) return;

  const interactive = isHuman() && !isAgent();

  if (!(await hasAccountCredentials())) {
    if (!interactive) {
      throw new AuthError({
        reason: AUTH_ERROR_REASON.NOT_LOGGED_IN,
        message:
          "Not logged in, so there is no Clerk instance to import into. Run `clerk auth login`, then `clerk link`.",
        examples: [
          { command: "clerk auth login", description: "Sign in, then re-run the import" },
          {
            command: "clerk migrate import users.json --source clerk -y --secret-key sk_test_...",
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
  if (interactive && !(await resolveProfile(process.cwd()))) {
    log.info("This directory isn't linked to a Clerk application. Linking one first...");
    await link({ skipIfLinked: true });
  }
}

/**
 * Settles which file to read: the positional argument or `--file`, where the
 * argument may name the export run that wrote the file.
 */
async function resolveInput(
  options: MigrateRunOptions,
): Promise<{ file?: string; fromExport?: string }> {
  if (options.input && options.file) {
    throwUsageError("Name the file once: either as the argument or with --file, not both.");
  }
  const value = options.input ?? options.file;
  if (!value) return {};
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
  return { file: record.file.path, fromExport: record.id };
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

export async function run(rawOptions: MigrateRunOptions): Promise<void> {
  await ensureImportTarget(rawOptions);
  rawOptions = await applySource(rawOptions);

  const input = await resolveInput(rawOptions);
  rawOptions = { ...rawOptions, file: input.file, input: undefined };
  const envelope =
    input.file && fileExists(input.file)
      ? readEnvelope(resolveImportFilePath(input.file))
      : undefined;
  rawOptions = applyEnvelope(rawOptions, envelope);

  const options = await resolveMissingOptions(rawOptions);

  const { source, file } = validateRunOptions(options);
  // The flags win, so a rotated key can be passed without re-exporting.
  const firebaseHashConfig =
    resolveFirebaseHashConfig(options, source) ??
    (source === "firebase" ? envelope?.firebase : undefined);

  await withGutter("Migrating users to Clerk", async ({ setNextSteps }) => {
    const { secretKey, target } = await resolveClerkTarget(options);
    const limits = resolveLimits(secretKey);

    const {
      users: loaded,
      validationFailed,
      failures,
    } = await withSpinner(`Loading users from ${file}...`, async () =>
      loadUsersFromFile(file, source, { context: { firebaseHashConfig } }),
    );

    let users = applyResumeAfter(loaded, options.resumeAfter);
    if (options.resumeAfter) {
      log.info(`Resuming after ${options.resumeAfter} (${loaded.length - users.length} skipped).`);
    }

    // Users left out on purpose. Recorded as skipped, so the run says who they
    // were rather than only how many.
    const skipped: { user: User; reason: string }[] = [];

    if (options.skipUnsupportedProviders) {
      const excluded = await findDisabledProviderUsers(file, source, secretKey);
      for (const user of users.filter((candidate) => excluded.has(candidate.userId))) {
        skipped.push({ user, reason: "only provider is not enabled in Clerk" });
      }
      users = users.filter((user) => !excluded.has(user.userId));
    }

    if (options.requirePassword) {
      const withPassword = users.filter((user) => Boolean(user.password));
      const dropped = users.length - withPassword.length;
      if (dropped > 0) {
        log.info(
          `--require-password: skipping ${dropped} user${dropped === 1 ? "" : "s"} without a password.`,
        );
      }
      for (const user of users.filter((candidate) => !candidate.password)) {
        skipped.push({ user, reason: "no password (--require-password)" });
      }
      users = withPassword;
    }

    if (validationFailed > 0) {
      log.warn(
        `${validationFailed} user${validationFailed === 1 ? "" : "s"} failed validation and will be skipped.`,
      );
    }

    const runsDir = await resolveRunsDir(options.runsDir, { write: true });
    const beginRun = () => {
      const filePath = resolveImportFilePath(file);
      const run = startRun(runsDir, {
        kind: "import",
        target,
        source,
        ...(options.sourceHash ? { sourceHash: options.sourceHash } : {}),
        file: { path: filePath, sha256: sha256File(filePath) },
        ...(input.fromExport ? { fromExport: input.fromExport } : {}),
      });
      for (const failure of failures) {
        run.append({
          sourceId: failure.userId,
          status: "failed",
          error: `${failure.error} (${failure.path.join(".") || "user"}, row ${failure.row + 1})`,
          code: "validation",
        });
      }
      for (const { user, reason } of skipped) {
        run.append({ sourceId: user.userId, status: "skipped", reason });
      }
      return run;
    };

    if (users.length === 0) {
      log.warn("No users left to import.");
      // Still a run: the record of who failed validation, and why, is the one
      // thing this attempt produced.
      if (failures.length > 0 || skipped.length > 0) {
        const record = beginRun().finish();
        log.info(dim(`Run ${record.id}: ${path.join(runsDir, record.id)}`));
        process.exitCode = 1;
      }
      return;
    }

    const quotaRejections =
      limits.instanceType === "dev"
        ? await confirmDevUserLimit(users.length, secretKey, Boolean(options.yes))
        : 0;

    log.info(
      `Importing ${users.length} user${users.length === 1 ? "" : "s"} from ${source} into ` +
        `${describeTarget(target)}.`,
    );

    await showReadinessReport({
      users,
      file,
      source,
      secretKey,
      validationFailed,
      skipReport: Boolean(options.yes),
      options,
    });

    if (!options.yes && isHuman() && !isAgent()) {
      // The readiness report counts the whole file, because settings decide
      // what Clerk *accepts*. The quota decides how much of it gets in at all,
      // so the last prompt — the one that starts writing — restates that split
      // rather than asking about a number the instance will not take.
      const importable = users.length - quotaRejections;
      const proceed = await confirm({
        message: quotaRejections
          ? `Import ${importable} user${importable === 1 ? "" : "s"} and expect ${quotaRejections} to fail?`
          : `Import ${users.length} user${users.length === 1 ? "" : "s"}?`,
        default: false,
      });
      if (!proceed) throwUserAbort();
    }

    const run = beginRun();
    const summary = await withSpinner(`Importing users: [0/${users.length}]...`, async (spinner) =>
      importUsers({
        users,
        secretKey,
        limits,
        record: run.append,
        skipPasswordRequirement: !options.requirePassword,
        validationFailed,
        spinner,
      }),
    );
    const record = run.finish();

    log.info(formatSummary(summary, record, run.dir, limits.instanceType));

    // Offered even when some users failed: a partial import is exactly when
    // reading the per-user record matters most.
    const steps =
      summary.failed > 0
        ? NEXT_STEPS.MIGRATE_DONE_WITH_ERRORS(record.id)
        : NEXT_STEPS.MIGRATE_DONE(record.id);
    setNextSteps(steps);
    printAgentNextSteps(steps);

    if (summary.failed > 0) process.exitCode = 1;
  });
}
