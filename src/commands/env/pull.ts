import { join } from "node:path";
import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchApplication, PlapiError } from "../../lib/plapi.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../lib/dotenv.ts";
import { detectPublishableKeyName } from "../../lib/framework.ts";

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
    console.error("No Clerk project linked to this directory. Run `clerk init` to set up.");
    process.exit(1);
  }

  const { profile } = resolved;

  let instance: { id: string; label: string };
  try {
    instance = resolveInstanceId(profile, options.instance);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  console.error(`Pulling env vars from ${instance.label} instance...`);

  let app;
  try {
    app = await fetchApplication(profile.appId);
  } catch (error) {
    if (error instanceof PlapiError) {
      console.error(`Failed to fetch API keys: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof Error) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const matched = app.instances.find((i) => i.instance_id === instance.id);
  if (!matched) {
    console.error(`Instance ${instance.id} not found in application response.`);
    process.exit(1);
  }

  const publishableKeyName = await detectPublishableKeyName(process.cwd());
  const targetFile = await resolveTargetFile(process.cwd(), options.file);

  const file = Bun.file(targetFile);
  const existingContent = (await file.exists()) ? await file.text() : "";

  const lines = parseEnvFile(existingContent);
  const merged = mergeEnvVars(lines, {
    [publishableKeyName]: matched.publishable_key,
    CLERK_SECRET_KEY: matched.secret_key,
  });
  const output = serializeEnvFile(merged);

  await Bun.write(targetFile, output);

  const displayPath = options.file ?? targetFile.split("/").pop()!;
  console.error(`Environment variables written to ${displayPath}`);
}
