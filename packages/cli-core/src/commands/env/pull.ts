import { resolve, join, basename } from "node:path";
import { resolveAppContext, type AppContextOptions } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import {
  parseEnvFile,
  mergeEnvVars,
  serializeEnvFile,
  envFileHasClerkKeys,
} from "../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
  detectFramework,
  isNpmFramework,
} from "../../lib/framework.ts";
import { CliError, ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import {
  findLocalPublishableKey,
  hasKeyPairMismatch,
  resolveKeylessTarget,
  type KeylessTarget,
} from "../../lib/keyless-target.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

const DEV_LOCAL_ENV_FILE = ".env.development.local";

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
  return envFileHasClerkKeys(content);
}

async function resolveTargetFile(
  cwd: string,
  flag?: string,
  fallbackFile: string = ".env.local",
): Promise<string> {
  // resolve (not join) so absolute --file paths aren't nested under cwd.
  if (flag) return resolve(cwd, flag);

  const devLocal = join(cwd, DEV_LOCAL_ENV_FILE);
  if (await Bun.file(devLocal).exists()) return devLocal;

  const fallback = join(cwd, fallbackFile);
  if (await Bun.file(fallback).exists()) return fallback;

  // Backwards compat: if the non-fallback file already has Clerk keys,
  // keep writing there so we don't leave stale keys behind.
  const other = fallbackFile === ".env" ? ".env.local" : ".env";
  if (await hasClerkKeys(join(cwd, other))) return join(cwd, other);

  return fallback;
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
    findLocalPublishableKey(cwd),
  ]);

  // The secret and publishable key were found independently and may not name
  // the same application. Writing a mismatched pair is worse than writing
  // nothing: it produces an app that fails at runtime in a way that's very
  // hard to trace back to its cause, so this is the stricter of the two
  // checks — whoami only warns, this refuses to write.
  if (publishableKey) {
    const mismatch = await withApiContext(
      hasKeyPairMismatch(keyless, publishableKey),
      `Failed to verify the accountless secret key from \`${keyless.source}\``,
    );
    if (mismatch) {
      throw new CliError(
        `The publishable key found locally doesn't belong to the application the secret key from \`${keyless.source}\` addresses. Writing this pair would leave the server trusting one app while the browser talks to another.\n` +
          `Remove the mismatched ${publishableKeyName} from your env files, or run \`clerk auth login\` to claim the intended application, then pull again.`,
        { code: ERROR_CODE.KEY_PAIR_MISMATCH },
      );
    }
  }

  const vars = {
    [secretKeyName]: keyless.secretKey,
    ...(publishableKey && { [publishableKeyName]: publishableKey }),
  };

  if (options.print) {
    log.data(formatEnvLines(vars));
  } else {
    const targetFile = await resolveTargetFile(cwd, options.file, await detectEnvFile(cwd));
    await mergeKeysIntoEnvFile(targetFile, vars);
    log.info(
      `Accountless application keys from \`${keyless.source}\` written to ${options.file ?? basename(targetFile)}`,
    );
  }
  if (!publishableKey) {
    log.warn(
      `No publishable key found locally — set ${publishableKeyName} manually, or run \`clerk auth login\` to claim the application.`,
    );
  }
}
