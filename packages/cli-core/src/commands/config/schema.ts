import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  // Use `console.error` for informational messages so stdout is just the JSON response.
  console.error(`Pulling config schema from ${ctx.instanceLabel} instance...`);

  const schema = await withApiContext(
    fetchInstanceConfigSchema(ctx.appId, ctx.instanceId, options.keys),
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
