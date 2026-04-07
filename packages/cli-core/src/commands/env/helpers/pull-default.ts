/**
 * Default "pull dev keys to .env.local" flow.
 *
 * Encapsulates the body of `clerk env pull` so init (and other entry points)
 * can run the same flow without invoking the public command. The exported
 * `pullDefault` accepts the same options shape as the public command.
 */

import { join } from "node:path";
import type { Need } from "../../../lib/deps.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
} from "../../../lib/framework.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../../lib/errors.ts";
import { dim } from "../../../lib/color.ts";

export type PullDefaultDeps = Need<{
  plapi: "fetchApplication";
  configStore: "resolveAppContext";
  spinner: "withSpinner";
  log: "info";
}>;

export interface PullDefaultOptions {
  app?: string;
  instance?: string;
  file?: string;
}

/** Check whether a file contains Clerk keys (for backwards compat detection). */
async function hasClerkKeys(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const content = await file.text();
  return /(?:CLERK_SECRET_KEY|(?:\w+_)?CLERK_PUBLISHABLE_KEY)=/.test(content);
}

const DEV_LOCAL_ENV_FILE = ".env.development.local";

async function resolveTargetFile(
  cwd: string,
  flag?: string,
  fallbackFile: string = ".env.local",
): Promise<string> {
  if (flag) return join(cwd, flag);

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

export async function pullDefault(
  deps: PullDefaultDeps,
  options: PullDefaultOptions = {},
): Promise<void> {
  const ctx = await deps.configStore.resolveAppContext(options);
  const cwd = process.cwd();
  const preferredEnvFile = await detectEnvFile(cwd);
  const targetFile = await resolveTargetFile(cwd, options.file, preferredEnvFile);
  const displayPath = options.file ?? targetFile.split("/").pop()!;

  await deps.spinner.withSpinner(
    `Pulling env vars from ${ctx.instanceLabel} instance...`,
    async () => {
      const app = await withApiContext(
        deps.plapi.fetchApplication(ctx.appId),
        "Failed to fetch API keys",
      );

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
    },
  );

  deps.log.info(dim(`Environment variables written to ${displayPath}`));
}
