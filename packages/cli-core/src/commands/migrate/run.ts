/**
 * `clerk migrate run` — non-interactive user import.
 *
 * Ported from the standalone migration-tool's `src/migrate/cli.ts`
 * (`runNonInteractive`), with auth moved onto the CLI's standard secret-key
 * resolution chain and every failure raised as a `CliError` instead of
 * `console.error` + `process.exit`.
 *
 * The interactive wizard that a bare `clerk migrate` will launch is a separate
 * command; this path is the one an agent or a script drives.
 */

import { describeBapiTarget, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, dim, green, red, yellow } from "../../lib/color.ts";
import { CliError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { resolveInstanceTarget, type InstanceTarget } from "../../lib/keyless-target.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { confirm, multiselect } from "../../lib/prompts.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { writeInstanceConfig } from "../config/io.ts";
import { importUsers } from "./import-users.ts";
import { analyzeFields } from "./lib/analysis.ts";
import { findMigrateEnvValue } from "./lib/env-file.ts";
import {
  enabledSocialProviders,
  fetchInstanceSettings,
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
import { DEV_USER_LIMIT, resolveLimits } from "./lib/instance.ts";
import { getDateTimeStamp, getLogFilePath } from "./lib/logger.ts";
import { saveSettings } from "./lib/settings.ts";
import {
  countSocialProviders,
  findDisabledProviders,
  findUsersWithOnlyDisabledProviders,
  readSupabaseRows,
} from "./lib/supabase-providers.ts";
import { fileExists, getFileType, loadUsersFromFile } from "./lib/transform.ts";
import { loadCustomTransformer } from "./transformers/load-custom.ts";
import { registerCustomTransformer, transformerKeys } from "./transformers/registry.ts";
import type { FirebaseHashConfig, ImportSummary, User } from "./types.ts";
import { runWizard, throwAgentFlagsRequired } from "./wizard.ts";

export type MigrateRunOptions = {
  transformer?: string;
  file?: string;
  resumeAfter?: string;
  requirePassword?: boolean;
  yes?: boolean;
  secretKey?: string;
  /** Deprecated alias for `--secret-key`, kept for existing prompts and docs. */
  clerkSecretKey?: string;
  app?: string;
  instance?: string;
  /** Path to a user-authored transformer, for a platform with no built-in. */
  transformerFile?: string;
  /** Supabase: drop users whose only social provider is disabled in Clerk. */
  skipUnsupportedProviders?: boolean;
  firebaseSignerKey?: string;
  firebaseSaltSeparator?: string;
  firebaseRounds?: number;
  firebaseMemCost?: number;
};

const FIREBASE_FLAGS = [
  ["firebaseSignerKey", "--firebase-signer-key", "CLERK_FIREBASE_SIGNER_KEY"],
  ["firebaseSaltSeparator", "--firebase-salt-separator", "CLERK_FIREBASE_SALT_SEPARATOR"],
  ["firebaseRounds", "--firebase-rounds", "CLERK_FIREBASE_ROUNDS"],
  ["firebaseMemCost", "--firebase-mem-cost", "CLERK_FIREBASE_MEM_COST"],
] as const;

const FIREBASE_NUMERIC: ReadonlySet<string> = new Set(["firebaseRounds", "firebaseMemCost"]);

/**
 * Overlays the `CLERK_FIREBASE_*` values onto whichever flags were not passed.
 *
 * Resolved through {@link findMigrateEnvValue}: the environment first, then
 * `.env.clerk-migrate`, then the app's own `.env` files. The signer key is a
 * Firebase secret, so it is never written to the CLI's config —
 * `.env.clerk-migrate` is gitignored on creation.
 */
async function withFirebaseEnv(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  const merged = { ...options };
  for (const [key, , envVar] of FIREBASE_FLAGS) {
    if (merged[key] !== undefined) continue;
    const located = await findMigrateEnvValue([envVar]);
    if (!located || located.value.trim() === "") continue;
    // A non-numeric round count is left to fail the flag's own validation
    // rather than silently becoming NaN.
    (merged as Record<string, unknown>)[key] = FIREBASE_NUMERIC.has(key)
      ? Number(located.value)
      : located.value;
  }
  return merged;
}

/**
 * Resolves Firebase's four hash parameters from flags, falling back to the
 * `CLERK_FIREBASE_*` environment variables and the project's `.env` files.
 *
 * The four are required as a set: a digest built from a partial set is
 * well-formed but verifies against nothing, so every migrated user would fail
 * to sign in with no error at import time.
 *
 * @returns The config, or `undefined` when none was supplied — which is fine
 *   for an export that carries no password hashes.
 */
export async function resolveFirebaseHashConfig(
  rawOptions: MigrateRunOptions,
): Promise<FirebaseHashConfig | undefined> {
  const options = await withFirebaseEnv(rawOptions);
  const provided = FIREBASE_FLAGS.filter(([key]) => options[key] !== undefined);

  if (provided.length === 0) return undefined;

  if (provided.length < FIREBASE_FLAGS.length) {
    const missing = FIREBASE_FLAGS.filter(([key]) => options[key] === undefined).map(
      ([, flag]) => flag,
    );
    throwUsageError(
      `The Firebase hash parameters must be supplied together. Missing: ${missing.join(", ")}.\n` +
        "Find all four in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
      "https://clerk.com/docs/guides/development/migrating/firebase",
    );
  }

  return {
    base64_signer_key: options.firebaseSignerKey as string,
    base64_salt_separator: options.firebaseSaltSeparator as string,
    rounds: options.firebaseRounds as number,
    mem_cost: options.firebaseMemCost as number,
  };
}

/**
 * Validates the flags a run needs before anything is read or sent.
 *
 * @returns The transformer key and file path, both guaranteed present.
 */
export function validateRunOptions(options: MigrateRunOptions): {
  transformer: string;
  file: string;
} {
  const valid = transformerKeys();

  // A custom transformer has already been loaded and registered by the time
  // this runs, so its key is resolvable even though it is not in `valid`.
  if (options.transformerFile) {
    if (!options.file) {
      throwUsageError(
        "Missing required option --file (path to a JSON or CSV export).",
        undefined,
        ERROR_CODE.USAGE_ERROR,
        [
          {
            command:
              "clerk migrate run -y --transformer-file ./my-transformer.ts --file users.json",
            description: "Import with a custom transformer",
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
    return { transformer: options.transformer as string, file: options.file };
  }

  if (!options.transformer) {
    throwUsageError(
      `Missing required option --transformer. Valid values: ${valid.join(", ")}.`,
      undefined,
      ERROR_CODE.USAGE_ERROR,
      [
        {
          command: "clerk migrate run -y --transformer clerk --file users.json",
          description: "Import a Clerk export",
        },
      ],
    );
  }
  if (!valid.includes(options.transformer)) {
    throwUsageError(
      `Unknown transformer "${options.transformer}". Valid values: ${valid.join(", ")}.`,
    );
  }
  if (!options.file) {
    throwUsageError(
      "Missing required option --file (path to a JSON or CSV export).",
      undefined,
      ERROR_CODE.USAGE_ERROR,
      [
        {
          command: "clerk migrate run -y --transformer clerk --file users.json",
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

  return { transformer: options.transformer, file: options.file };
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

function formatSummary(summary: ImportSummary, logFile: string): string {
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
  }
  lines.push("", dim(`Log: ${logFile}`));

  return lines.join("\n");
}

/**
 * Drops users whose only way into Clerk is a social provider the destination
 * instance has not enabled.
 *
 * Only meaningful for Supabase exports — it is the one platform whose export
 * records per-user providers. If the instance's configuration cannot be read,
 * nobody is dropped: a failed lookup must not be mistaken for "no providers
 * are enabled".
 */
async function skipDisabledProviderUsers(
  users: User[],
  file: string,
  transformer: string,
  secretKey: string,
): Promise<User[]> {
  if (transformer !== "supabase") {
    log.warn(`--skip-unsupported-providers only applies to supabase exports; ignoring.`);
    return users;
  }

  const settings = await withSpinner("Checking enabled providers...", () =>
    fetchInstanceSettings(secretKey),
  );
  const enabled = settings ? enabledSocialProviders(settings) : null;
  if (!enabled) {
    log.warn(
      "Could not read the instance's enabled providers; importing every user. Re-run with --verbose for details.",
    );
    return users;
  }

  const rows = await readSupabaseRows(file);
  const disabled = findDisabledProviders(rows, enabled, toClerkStrategy);
  if (disabled.length === 0) {
    log.info("Every provider in this export is enabled in Clerk; no users skipped.");
    return users;
  }

  const { excludedIds, byProvider } = findUsersWithOnlyDisabledProviders(rows, disabled);
  if (excludedIds.size === 0) {
    log.info(
      `${disabled.join(", ")} not enabled in Clerk, but every user has another way to sign in; none skipped.`,
    );
    return users;
  }

  const breakdown = Object.entries(byProvider)
    .map(([provider, count]) => `${provider}: ${count}`)
    .join(", ");
  log.warn(
    `--skip-unsupported-providers: skipping ${excludedIds.size} user${excludedIds.size === 1 ? "" : "s"} whose only provider is not enabled in Clerk (${breakdown}).`,
  );

  return users.filter((user) => !excludedIds.has(user.userId));
}

type ReportInput = {
  users: User[];
  file: string;
  transformer: string;
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
  if (input.transformer === "supabase") {
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

  await withSpinner(`Updating settings on ${target.label}...`, () =>
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

  let settings = await withSpinner("Checking instance settings...", () =>
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
 * Fills in a missing `--transformer`/`--file` interactively, or explains what
 * to pass.
 *
 * Agent mode is the CLI's existing non-interactive signal, so an agent that
 * runs bare `clerk migrate` gets a usage error naming the flags rather than a
 * prompt it cannot answer.
 */
async function resolveMissingOptions(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  const missing = { transformer: !options.transformer, file: !options.file };
  if (!missing.transformer && !missing.file) return options;

  if (isAgent() || !isHuman()) {
    throwAgentFlagsRequired(missing);
  }

  // A partial Firebase flag set is a usage error whether or not the wizard is
  // filling in the rest, so it is checked before any prompt.
  const firebaseHashConfig = await resolveFirebaseHashConfig(options);
  const answers = await runWizard({
    transformer: options.transformer,
    file: options.file,
    firebaseHashConfig,
  });

  return {
    ...options,
    transformer: answers.transformer,
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
 * Loads and registers a `--transformer-file`, so the rest of the run treats it
 * exactly like a built-in.
 *
 * @returns The options with `transformer` set to the loaded entry's key.
 */
async function applyCustomTransformer(options: MigrateRunOptions): Promise<MigrateRunOptions> {
  if (!options.transformerFile) return options;

  // Both name a transformer, and there is no sensible precedence between "the
  // one you wrote" and "the one we ship" — say so rather than picking.
  if (options.transformer) {
    throwUsageError(
      "--transformer and --transformer-file both name a transformer. Pass one or the other.",
      undefined,
      undefined,
      [
        {
          command: "clerk migrate run -y --transformer-file ./my-transformer.ts --file users.json",
          description: "Use a transformer you wrote",
        },
        {
          command: "clerk migrate run -y --transformer clerk --file users.json",
          description: "Use a built-in transformer",
        },
      ],
    );
  }

  const custom = await loadCustomTransformer(options.transformerFile);
  registerCustomTransformer(custom);
  log.info(`Loaded the \`${custom.key}\` transformer from ${options.transformerFile}.`);

  return { ...options, transformer: custom.key };
}

export async function run(rawOptions: MigrateRunOptions): Promise<void> {
  if (rawOptions.clerkSecretKey) {
    log.warn("--clerk-secret-key is deprecated; use --secret-key instead.");
  }

  rawOptions = await applyCustomTransformer(rawOptions);
  const options = await resolveMissingOptions(rawOptions);
  const secretKeyOption = options.secretKey ?? options.clerkSecretKey;

  const { transformer, file } = validateRunOptions(options);
  const firebaseHashConfig = await resolveFirebaseHashConfig(options);

  await withGutter("Migrating users to Clerk", async ({ setNextSteps }) => {
    const target = await describeBapiTarget({ ...options, secretKey: secretKeyOption });
    const secretKey = await resolveBapiSecretKey({ ...options, secretKey: secretKeyOption });
    const limits = resolveLimits(secretKey);
    const dateTime = getDateTimeStamp();
    const logFile = getLogFilePath("migration", dateTime);

    const { users: loaded, validationFailed } = await withSpinner(
      `Loading users from ${file}...`,
      () => loadUsersFromFile(file, transformer, dateTime, { context: { firebaseHashConfig } }),
    );

    let users = applyResumeAfter(loaded, options.resumeAfter);
    if (options.resumeAfter) {
      log.info(`Resuming after ${options.resumeAfter} (${loaded.length - users.length} skipped).`);
    }

    if (options.skipUnsupportedProviders) {
      users = await skipDisabledProviderUsers(users, file, transformer, secretKey);
    }

    if (options.requirePassword) {
      const withPassword = users.filter((user) => Boolean(user.password));
      const dropped = users.length - withPassword.length;
      if (dropped > 0) {
        log.info(
          `--require-password: skipping ${dropped} user${dropped === 1 ? "" : "s"} without a password.`,
        );
      }
      users = withPassword;
    }

    if (validationFailed > 0) {
      log.warn(
        `${validationFailed} user${validationFailed === 1 ? "" : "s"} failed validation and will be skipped. See ${logFile}.`,
      );
    }

    if (users.length === 0) {
      log.warn("No users left to import.");
      return;
    }

    if (limits.instanceType === "dev" && users.length > DEV_USER_LIMIT) {
      throw new CliError(
        `Cannot import ${users.length} users into a development instance — the limit is ${DEV_USER_LIMIT}.\n` +
          "Target a production instance, or reduce the import file.",
        { code: ERROR_CODE.USAGE_ERROR },
      );
    }

    // `target` already carries the instance's environment ("My App
    // (development)"), so the detected type is only worth spelling out when
    // there is no app context to name — an explicit `--secret-key`.
    log.info(
      `Importing ${users.length} user${users.length === 1 ? "" : "s"} via the ${transformer} transformer into ` +
        `${target ?? `the resolved instance (${limits.instanceType})`}.`,
    );

    await showReadinessReport({
      users,
      file,
      transformer,
      secretKey,
      validationFailed,
      skipReport: Boolean(options.yes),
      options,
    });

    if (!options.yes && isHuman() && !isAgent()) {
      const proceed = await confirm({
        message: `Import ${users.length} user${users.length === 1 ? "" : "s"}?`,
        default: false,
      });
      if (!proceed) throwUserAbort();
    }

    // The Firebase hash parameters are deliberately not among these: the signer
    // key is a secret, and remembering it would write it to disk in plaintext.
    await saveSettings({
      transformer,
      file,
      ...(options.skipUnsupportedProviders ? { skipUnsupportedProviders: true } : {}),
    });

    const summary = await withSpinner(`Importing users: [0/${users.length}]...`, (spinner) =>
      importUsers({
        users,
        secretKey,
        limits,
        dateTime,
        skipPasswordRequirement: !options.requirePassword,
        validationFailed,
        spinner,
      }),
    );

    log.info(formatSummary(summary, logFile));

    // Offered even when some users failed: a partial import is exactly when
    // reading the log and knowing how to undo it matters most.
    setNextSteps(NEXT_STEPS.MIGRATE_DONE);

    if (summary.failed > 0) process.exitCode = 1;
  });
}
