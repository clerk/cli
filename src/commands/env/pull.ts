import { join } from "node:path";
import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import { detectPublishableKeyName } from "../../lib/framework.ts";
import { CliError, withApiContext } from "../../lib/errors.ts";

interface EnvPullOptions {
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
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` to set up.");
  }

  const { profile } = resolved;
  const instance = resolveInstanceId(profile, options.instance);

  console.error(`Pulling env vars from ${instance.label} instance...`);

  const app = await withApiContext(
    fetchApplication(profile.appId, true),
    "Failed to fetch API keys",
  );

  const matched = app.instances.find((i) => i.instance_id === instance.id);
  if (!matched) {
    throw new CliError(`Instance ${instance.id} not found in application response.`, {
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }

  const publishableKeyName = await detectPublishableKeyName(process.cwd());
  const targetFile = await resolveTargetFile(process.cwd(), options.file);

  const file = Bun.file(targetFile);
  const existingContent = (await file.exists()) ? await file.text() : "";

  const lines = parseEnvFile(existingContent);
  const vars: Record<string, string> = {
    [publishableKeyName]: matched.publishable_key,
  };
  if (matched.secret_key) {
    vars.CLERK_SECRET_KEY = matched.secret_key;
  }
  const merged = mergeEnvVars(lines, vars);
  const output = serializeEnvFile(merged);

  await Bun.write(targetFile, output);

  const displayPath = options.file ?? targetFile.split("/").pop()!;
  console.error(`Environment variables written to ${displayPath}`);
}
