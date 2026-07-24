import { resolve, join, basename } from "node:path";
import { resolveAppContext, type AppContextOptions } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
  detectFramework,
  isNpmFramework,
} from "../../lib/framework.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import {
  findLocalPublishableKey,
  resolveKeylessTarget,
  type KeylessTarget,
} from "../../lib/keyless-target.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

const DEV_LOCAL_ENV_FILE = ".env.development.local";

interface EnvPullOptions extends AppContextOptions {
  file?: string;
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
  await withGutter("Pulling environment variables", async () => {
    const cwd = options.cwd ?? process.cwd();

    // A keyless application's keys are already on this machine — that's the only
    // place they exist. "Pulling" them means copying what an SDK minted into the
    // env file the framework reads, not fetching from an account.
    const keyless = await resolveKeylessTarget({ ...options, cwd });
    if (keyless) {
      await pullKeylessKeys(cwd, keyless, options.file);
      return;
    }

    const [ctx, preferredEnvFile] = await Promise.all([
      resolveAppContext({ ...options, cwd }),
      detectEnvFile(cwd),
    ]);
    const targetFile = await resolveTargetFile(cwd, options.file, preferredEnvFile);
    const displayPath = options.file ?? basename(targetFile);

    await withSpinner(`Pulling env vars from ${ctx.instanceLabel} instance...`, async () => {
      const app = await withApiContext(fetchApplication(ctx.appId), "Failed to fetch API keys");

      const matched = app.instances.find((i) => i.instance_id === ctx.instanceId);
      if (!matched) {
        throw new CliError(`Instance ${ctx.instanceId} not found in application response.`, {
          code: ERROR_CODE.INSTANCE_NOT_FOUND,
          docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
        });
      }

      const publishableKeyName = await detectPublishableKeyName(cwd);
      const secretKeyName = await detectSecretKeyName(cwd);
      // Native platforms (iOS/Android) configure Clerk with only the publishable
      // key in client source; a secret key has no use there and their default
      // .gitignore templates don't cover .env, so skip writing it entirely
      // rather than leaving a live credential in a tracked file.
      const framework = await detectFramework(cwd);
      const includeSecretKey = isNpmFramework(framework ?? {});

      await mergeKeysIntoEnvFile(targetFile, {
        [publishableKeyName]: matched.publishable_key,
        ...(matched.secret_key && includeSecretKey && { [secretKeyName]: matched.secret_key }),
      });
    });

    log.info(`Environment variables written to ${displayPath}`);
  });
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
 * Writes a keyless application's local keys into the project's env file. The
 * publishable key can be missing when an SDK holds only part of the pair; the
 * secret key is always present because it's what identified the target.
 */
async function pullKeylessKeys(
  cwd: string,
  keyless: KeylessTarget,
  fileFlag?: string,
): Promise<void> {
  const [preferredEnvFile, publishableKeyName, secretKeyName, publishableKey] = await Promise.all([
    detectEnvFile(cwd),
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
    findLocalPublishableKey(cwd),
  ]);

  const targetFile = await resolveTargetFile(cwd, fileFlag, preferredEnvFile);
  const displayPath = fileFlag ?? basename(targetFile);

  await mergeKeysIntoEnvFile(targetFile, {
    [secretKeyName]: keyless.secretKey,
    ...(publishableKey && { [publishableKeyName]: publishableKey }),
  });

  log.info(`Keyless application keys from \`${keyless.source}\` written to ${displayPath}`);
  if (!publishableKey) {
    log.warn(
      `No publishable key found locally — set ${publishableKeyName} manually, or run \`clerk auth login\` to claim the application.`,
    );
  }
}
