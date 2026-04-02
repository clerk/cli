import { join } from "node:path";
import { resolveAppContext } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import {
  detectPublishableKeyName,
  detectSecretKeyName,
  detectEnvFile,
} from "../../lib/framework.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";

interface EnvPullOptions {
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

async function resolveTargetFile(
  cwd: string,
  flag?: string,
  preferredFile: string = ".env.local",
): Promise<string> {
  if (flag) return join(cwd, flag);

  const preferred = join(cwd, preferredFile);
  if (await Bun.file(preferred).exists()) return preferred;

  // Backwards compat: if the non-preferred file already has Clerk keys,
  // keep writing there so we don't leave stale keys behind.
  const other = preferredFile === ".env" ? ".env.local" : ".env";
  const otherPath = join(cwd, other);
  if (await hasClerkKeys(otherPath)) return otherPath;

  return preferred;
}

export async function pull(options: EnvPullOptions): Promise<void> {
  const ctx = await resolveAppContext(options);
  const cwd = process.cwd();
  const preferredEnvFile = await detectEnvFile(cwd);
  const targetFile = await resolveTargetFile(cwd, options.file, preferredEnvFile);
  const displayPath = options.file ?? targetFile.split("/").pop()!;

  await withSpinner(
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
    `Environment variables written to ${displayPath}`,
  );
}
