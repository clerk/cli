import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { CliError, withApiContext } from "../../lib/errors.ts";

interface ConfigSchemaOptions {
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` to set up.");
  }

  const { profile } = resolved;
  const instance = resolveInstanceId(profile, options.instance);

  // Use `console.error` for informational messages so stdout is just the JSON response.
  console.error(`Pulling config schema from ${instance.label} instance...`);

  const schema = await withApiContext(
    fetchInstanceConfigSchema(profile.appId, instance.id, options.keys),
    "Failed to fetch config schema",
  );

  const json = JSON.stringify(schema, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    console.error(`Schema written to ${options.output}`);
  } else {
    console.log(json);
  }
}
