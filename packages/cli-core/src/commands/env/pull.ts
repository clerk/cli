import { join } from "node:path";
import { resolveAppContext } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "../../lib/framework.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";

interface EnvPullOptions {
  app?: string;
  instance?: string;
  file?: string;
}

async function resolveTargetFile(cwd: string, flag?: string): Promise<string> {
  if (flag) return join(cwd, flag);

  const envLocal = Bun.file(join(cwd, ".env.local"));
  if (await envLocal.exists()) return join(cwd, ".env.local");

  const envFile = Bun.file(join(cwd, ".env"));
  if (await envFile.exists()) return join(cwd, ".env");

  return join(cwd, ".env.local");
}

export async function pull(options: EnvPullOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  console.error(`Pulling env vars from ${ctx.instanceLabel} instance...`);

  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to fetch API keys");

  const matched = app.instances.find((i) => i.instance_id === ctx.instanceId);
  if (!matched) {
    throw new CliError(`Instance ${ctx.instanceId} not found in application response.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }

  const cwd = process.cwd();
  const publishableKeyName = await detectPublishableKeyName(cwd);
  const secretKeyName = await detectSecretKeyName(cwd);
  const targetFile = await resolveTargetFile(cwd, options.file);

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

  const displayPath = options.file ?? targetFile.split("/").pop()!;
  console.error(`Environment variables written to ${displayPath}`);
}
