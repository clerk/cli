import { resolve, join, basename } from "node:path";
import { resolveAppContext, type AppContextOptions } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
} from "../../lib/framework.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner, formatTargetSuffix } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

const DEV_LOCAL_ENV_FILE = ".env.development.local";

interface EnvPullOptions extends AppContextOptions {
  file?: string;
  /**
   * Render as a single step inside the caller's frame instead of opening a gutter.
   */
  embed?: boolean;
  /**
   * Display label for the source instance, overriding the resolved context label.
   */
  label?: string;
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
  const cwd = options.cwd ?? process.cwd();
  const [ctx, preferredEnvFile] = await Promise.all([
    resolveAppContext({ ...options, cwd }),
    detectEnvFile(cwd),
  ]);
  const displayLabel = options.label ?? ctx.instanceLabel;
  const targetFile = await resolveTargetFile(cwd, options.file, preferredEnvFile);
  const displayPath = options.file ?? basename(targetFile);

  const writeEnvFile = async () => {
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

    const file = Bun.file(targetFile);
    const existingContent = (await file.exists()) ? await file.text() : "";

    const lines = parseEnvFile(existingContent);
    const vars: Record<string, string> = {
      [publishableKeyName]: matched.publishable_key,
    };
    if (matched.secret_key) {
      vars[secretKeyName] = matched.secret_key;
    }
    const merged = mergeEnvVars(lines, vars);
    const output = serializeEnvFile(merged);

    await Bun.write(targetFile, output);
  };

  if (options.embed) {
    // Inside a caller's frame (e.g. `clerk switch`): one resolved step line.
    await withSpinner(
      `Syncing ${displayPath} from ${displayLabel}...`,
      writeEnvFile,
      `Synced ${displayPath} from ${displayLabel}`,
    );
    return;
  }

  await withGutter(`Pulling environment variables${formatTargetSuffix(displayLabel)}`, async () => {
    await withSpinner(`Pulling env vars from ${displayLabel} instance...`, writeEnvFile);
    log.info(`Environment variables written to ${displayPath}`);
  });
}
