import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchInstanceConfig, PlapiError } from "../../lib/plapi.ts";

interface ConfigPullOptions {
  instance?: string;
  output?: string;
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
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

  console.error(`Pulling config from ${instance.label} instance...`);

  let config: Record<string, unknown>;
  try {
    config = await fetchInstanceConfig(profile.appId, instance.id);
  } catch (error) {
    if (error instanceof PlapiError) {
      console.error(`Failed to fetch config: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof Error) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const json = JSON.stringify(config, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    console.error(`Config written to ${options.output}`);
  } else {
    console.log(json);
  }
}
