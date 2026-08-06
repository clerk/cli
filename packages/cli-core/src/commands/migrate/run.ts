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
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { importUsers } from "./import-users.ts";
import { analyzeFields } from "./lib/analysis.ts";
import { findMigrateEnvValue } from "./lib/env-file.ts";
import {
  enabledSocialProviders,
  fetchInstanceSettings,
  toClerkStrategy,
} from "./lib/clerk-config.ts";
import { buildReadinessReport, formatReadinessReport } from "./lib/readiness.ts";
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

  const settings = await withSpinner("Checking enabled providers", () =>
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
    `--skip-unsupported-providers: skipping ${excludedIds.size} user(s) whose only provider is not enabled in Clerk (${breakdown}).`,
  );

  return users.filter((user) => !excludedIds.has(user.userId));
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
 * driving a migration can act on "this field is required and 40 users lack it"
 * exactly as a human would.
 */
async function showReadinessReport(input: {
  users: User[];
  file: string;
  transformer: string;
  secretKey: string;
  validationFailed: number;
  skipReport: boolean;
}): Promise<void> {
  if (input.skipReport) return;

  const settings = await withSpinner("Checking instance settings", () =>
    fetchInstanceSettings(input.secretKey),
  );

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

  const report = buildReadinessReport({
    analysis: analyzeFields(input.users),
    settings,
    validationFailed: input.validationFailed,
    providerCounts,
  });

  log.blank();
  for (const line of formatReadinessReport(report)) log.info(line);
  log.blank();
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

  await withGutter("Migrating users to Clerk", async () => {
    const target = await describeBapiTarget({ ...options, secretKey: secretKeyOption });
    const secretKey = await resolveBapiSecretKey({ ...options, secretKey: secretKeyOption });
    const limits = resolveLimits(secretKey);
    const dateTime = getDateTimeStamp();
    const logFile = getLogFilePath("migration", dateTime);

    const { users: loaded, validationFailed } = await withSpinner(
      `Loading users from ${file}`,
      () => loadUsersFromFile(file, transformer, dateTime, { context: { firebaseHashConfig } }),
      "Users loaded",
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
        log.info(`--require-password: skipping ${dropped} user(s) without a password.`);
      }
      users = withPassword;
    }

    if (validationFailed > 0) {
      log.warn(
        `${validationFailed} user(s) failed validation and will be skipped. See ${logFile}.`,
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

    log.info(
      `Importing ${users.length} user(s) via the ${transformer} transformer into ` +
        `${target ?? "the resolved instance"} (${limits.instanceType}).`,
    );

    await showReadinessReport({
      users,
      file,
      transformer,
      secretKey,
      validationFailed,
      skipReport: Boolean(options.yes),
    });

    if (!options.yes && isHuman() && !isAgent()) {
      const proceed = await confirm({
        message: `Import ${users.length} user(s)?`,
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

    const summary = await withSpinner(
      `Importing users: [0/${users.length}]`,
      (spinner) =>
        importUsers({
          users,
          secretKey,
          limits,
          dateTime,
          skipPasswordRequirement: !options.requirePassword,
          validationFailed,
          spinner,
        }),
      "Import complete",
    );

    log.raw(formatSummary(summary, logFile));

    if (summary.failed > 0) process.exitCode = 1;
  });
}
