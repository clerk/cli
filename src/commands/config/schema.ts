import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchInstanceConfigSchema, PlapiError } from "../../lib/plapi.ts";

interface ConfigSchemaOptions {
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    console.error("No Clerk project linked to this directory. Run `clerk link` to set up.");
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

  // Use `console.error` for informational messages so stdout is just the JSON response.
  console.error(`Pulling config schema from ${instance.label} instance...`);

  let schema: Record<string, unknown>;
  try {
    schema = await fetchInstanceConfigSchema(profile.appId, instance.id, options.keys);
  } catch (error) {
    if (error instanceof PlapiError) {
      console.error(`Failed to fetch config schema: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof Error) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const json = JSON.stringify(schema, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    console.error(`Schema written to ${options.output}`);
  } else {
    console.log(json);
  }
}
