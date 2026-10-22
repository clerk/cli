import { resolve, join, basename } from "node:path";
import { resolveAppContext, type AppContextOptions } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import {
  parseEnvFile,
  mergeEnvVars,
  serializeEnvFile,
  type EnvFileName,
  type PreferredEnvFile,
} from "../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
  detectFramework,
  isNpmFramework,
} from "../../lib/framework.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import {
  findLocalPublishableKey,
  hasKeyPairMismatch,
  resolveKeylessTarget,
  type KeylessTarget,
} from "../../lib/keyless-target.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { keylessCopy } from "../../lib/copy.ts";
import {
  appInNoAccount,
  readUnlinkedFolder,
  unlinkedFolderError,
  unlinkedFolderNextStep,
  type Rerun,
} from "../../lib/unlinked-folder.ts";
import {
  describeKeyLocation,
  ENV_VAR_SOURCE_SUFFIX,
  SDK_KEYLESS_SOURCE,
  unreadGenericPublishableKey,
  type LocatedKey,
} from "../../lib/local-keys.ts";
import { quoteArg } from "../../lib/json-body.ts";
import { isAgent } from "../../mode.ts";

const DEV_LOCAL_ENV_FILE: EnvFileName = ".env.development.local";

interface EnvPullOptions extends AppContextOptions {
  file?: string;
  /** Print `KEY=value` lines to stdout instead of writing an env file. */
  print?: boolean;
}

/** Check whether a file contains Clerk keys (for backwards compat detection). */
async function hasClerkKeys(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const content = await file.text();
  return /(?:CLERK_SECRET_KEY|(?:\w+_)?CLERK_PUBLISHABLE_KEY)=/.test(content);
}

async function resolveTargetFile(
  cwd: string,
  flag?: string,
  fallbackFile: PreferredEnvFile = ".env.local",
): Promise<string> {
  // resolve (not join) so absolute --file paths aren't nested under cwd.
  if (flag) return resolve(cwd, flag);
  return join(cwd, await defaultTargetFile(cwd, fallbackFile));
}

/**
 * The env file `env pull` writes when no `--file` is given. Typed as an
 * `EnvFileName` so it can only be a file the claim check also reads
 * (`ENV_FILE_CANDIDATES`); exported for the test that pins that down. Only a
 * file the framework loads, when it documents its load order: Nuxt loads only
 * `.env`, so keys written anywhere else would be read by neither Nuxt nor the CLI.
 */
export async function defaultTargetFile(
  cwd: string,
  fallbackFile: PreferredEnvFile,
): Promise<EnvFileName> {
  const loadOrder = (await detectFramework(cwd))?.envLoadOrder;
  const loads = (file: EnvFileName) => !loadOrder || loadOrder.includes(file);

  if (loads(DEV_LOCAL_ENV_FILE) && (await Bun.file(join(cwd, DEV_LOCAL_ENV_FILE)).exists())) {
    return DEV_LOCAL_ENV_FILE;
  }

  if (await Bun.file(join(cwd, fallbackFile)).exists()) return fallbackFile;

  // Backwards compat: if the non-fallback file already has Clerk keys,
  // keep writing there so we don't leave stale keys behind.
  const other: PreferredEnvFile = fallbackFile === ".env" ? ".env.local" : ".env";
  if (loads(other) && (await hasClerkKeys(join(cwd, other)))) return other;

  return fallbackFile;
}

export async function pull(options: EnvPullOptions): Promise<void> {
  if (options.print && options.file) {
    throwUsageError("--print and --file cannot be combined.");
  }

  await withGutter("Pulling environment variables", async () => {
    const cwd = options.cwd ?? process.cwd();

    // A keyless application's keys are already on this machine — that's the only
    // place they exist. "Pulling" them means copying what an SDK minted into the
    // env file the framework reads, not fetching from an account.
    const keyless = await resolveKeylessTarget({ ...options, cwd });
    if (keyless) {
      await pullKeylessKeys(cwd, keyless, options);
      return;
    }

    const ctx = await resolveAppContext({ ...options, cwd });

    const vars = await withSpinner(
      `Pulling env vars from ${ctx.instanceLabel} instance...`,
      async () => {
        const app = await withApiContext(fetchApplication(ctx.appId), "Failed to fetch API keys");

        const matched = app.instances.find((i) => i.instance_id === ctx.instanceId);
        if (!matched) {
          throw new CliError(`Instance ${ctx.instanceId} not found in application response.`, {
            code: ERROR_CODE.INSTANCE_NOT_FOUND,
            docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
          });
        }

        // --print is for handing both keys to a host. With only the publishable
        // key, the host keeps the secret key it already has (usually
        // development's), and the pair no longer matches.
        if (options.print && !matched.secret_key) {
          throw new CliError(
            `Clerk returned no secret key for the ${ctx.instanceLabel} instance, so --print printed nothing. ` +
              "Copy the keys from the API keys page in the Clerk Dashboard instead.",
            { code: ERROR_CODE.NO_SECRET_KEY },
          );
        }

        const publishableKeyName = await detectPublishableKeyName(cwd);
        const secretKeyName = await detectSecretKeyName(cwd);
        // Native platforms (iOS/Android) configure Clerk with only the publishable
        // key in client source; a secret key has no use there and their default
        // .gitignore templates don't cover .env, so skip writing it entirely
        // rather than leaving a live credential in a tracked file. --print
        // writes nothing, so it always includes the key.
        const includeSecretKey =
          options.print || isNpmFramework((await detectFramework(cwd)) ?? {});

        return {
          [publishableKeyName]: matched.publishable_key,
          ...(matched.secret_key && includeSecretKey && { [secretKeyName]: matched.secret_key }),
        };
      },
    );

    if (options.print) {
      log.data(formatEnvLines(vars));
      return;
    }

    const targetFile = await resolveTargetFile(cwd, options.file, await detectEnvFile(cwd));
    await mergeKeysIntoEnvFile(targetFile, vars);
    log.info(`Environment variables written to ${options.file ?? basename(targetFile)}`);
  });
}

/** `KEY=value` lines for --print. Clerk keys are plain tokens, so nothing needs quoting. */
function formatEnvLines(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Merges keys into an env file, preserving everything already in it. */
async function mergeKeysIntoEnvFile(
  targetFile: string,
  vars: Record<string, string>,
): Promise<void> {
  const file = Bun.file(targetFile);
  const existingContent = (await file.exists()) ? await file.text() : "";

  await Bun.write(targetFile, serializeEnvFile(mergeEnvVars(parseEnvFile(existingContent), vars)));
}

/**
 * Writes an accountless application's local keys into the project's env file. The
 * publishable key can be missing when an SDK holds only part of the pair; the
 * secret key is always present because it's what identified the target.
 */
async function pullKeylessKeys(
  cwd: string,
  keyless: KeylessTarget,
  options: Pick<EnvPullOptions, "file" | "print">,
): Promise<void> {
  const [publishableKeyName, secretKeyName, publishableKey] = await Promise.all([
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
    // An exported secret key is found without the env files; with one the CLI
    // can't read, which publishable key the app loads is untold.
    findLocalPublishableKey(cwd).catch(async () => {
      throw unlinkedFolderError(await readUnlinkedFolder(cwd), {
        lead: "No Clerk project linked to this directory.",
        rerun: envPullRerun(options),
      });
    }),
  ]);

  // The secret and publishable key were found independently and may not name
  // the same application. Writing a mismatched pair is worse than writing
  // nothing: it produces an app that fails at runtime in a way that's very
  // hard to trace back to its cause, so this is the stricter of the two
  // checks — whoami only warns, this refuses to write.
  if (publishableKey) {
    const mismatch = await hasKeyPairMismatch(keyless, publishableKey.value).catch(
      async (error: unknown) => {
        // Read only now, so a `--print` run whose check passes doesn't read the folder.
        if (error instanceof ApiError) {
          const accountless = appInNoAccount(await readUnlinkedFolder(cwd)) ? "accountless " : "";
          error.context = `Failed to verify the ${accountless}secret key from \`${keyless.source}\``;
        }
        throw error;
      },
    );
    if (mismatch) {
      // No `clerk link` advice: it would find the app by this publishable key,
      // which may be the wrong one.
      throw new CliError(
        `The publishable key found locally (${describeKeyLocation(publishableKey)}) doesn't belong to the application the secret key from \`${keyless.source}\` addresses. Writing this pair would leave the server trusting one app while the browser talks to another.\n` +
          removeStrayPublishableKey(publishableKey),
        { code: ERROR_CODE.KEY_PAIR_MISMATCH },
      );
    }
  }

  // Read before the write below adds the secret key to an env file, and only
  // when a line below names the folder's app or gives its step.
  const folder = !options.print || !publishableKey ? await readUnlinkedFolder(cwd) : undefined;

  const vars = {
    [secretKeyName]: keyless.secretKey,
    ...(publishableKey && { [publishableKeyName]: publishableKey.value }),
  };

  if (options.print) {
    log.data(formatEnvLines(vars));
  } else {
    const targetFile = await resolveTargetFile(cwd, options.file, await detectEnvFile(cwd));
    await mergeKeysIntoEnvFile(targetFile, vars);
    log.info(
      `${folder && appInNoAccount(folder) ? "Accountless application" : "This folder's application"} keys from \`${keyless.source}\` written to ${options.file ?? basename(targetFile)}`,
    );
  }
  if (folder && !publishableKey) {
    const { text: step } = unlinkedFolderNextStep(folder, {
      agent: isAgent(),
      rerun: envPullRerun(options),
    });
    // The keys are written, so a file that can't be read now only drops the hint.
    const skipped = await unreadGenericPublishableKey(cwd).catch(() => undefined);
    log.warn(
      keylessCopy.missingPublishableKey(
        publishableKeyName,
        step,
        skipped && { line: describeKeyLocation(skipped.location), framework: skipped.framework },
      ),
    );
  }
}

/** How to stop using a publishable key that belongs to another app, from where it was found. */
function removeStrayPublishableKey(located: LocatedKey): string {
  // The reader takes keys from the SDK keyless file only when the folder holds
  // no plain key, so both keys must go in the env file; deleting the SDK file
  // also deletes its app's claim link.
  if (located.source === SDK_KEYLESS_SOURCE) {
    return (
      "Add both keys of the app you want to your env file (keys there win over the SDK keyless file), then pull again. " +
      `Or delete the stale \`${SDK_KEYLESS_SOURCE}\`, which also deletes its claim link.`
    );
  }
  if (located.source === `${located.name}${ENV_VAR_SOURCE_SUFFIX}`) {
    return `Unset ${describeKeyLocation(located)} in your shell, then pull again.`;
  }
  return `Remove the mismatched \`${located.name}\` from ${located.source}, then pull again.`;
}

/** `clerk env pull` with the run's own flags, shell-quoted; the keyless path takes no others. */
function envPullRerun({ file, print }: Pick<EnvPullOptions, "file" | "print">): Rerun {
  const command = ["clerk env pull", file && `--file ${quoteArg(file)}`, print && "--print"]
    .filter(Boolean)
    .join(" ");
  return { clause: `run \`${command}\` again`, command };
}
