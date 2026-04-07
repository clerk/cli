import type { Need } from "../../lib/deps.ts";
import { withApiContext } from "../../lib/errors.ts";

export type ConfigSchemaDeps = Need<{
  plapi: "fetchInstanceConfigSchema";
  configStore: "resolveAppContext";
  log: "info" | "success" | "data";
}>;

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(
  deps: ConfigSchemaDeps,
  options: ConfigSchemaOptions,
): Promise<void> {
  const ctx = await deps.configStore.resolveAppContext(options);

  deps.log.info(`Pulling config schema from ${ctx.appLabel} (${ctx.instanceLabel})...`);

  const schema = await withApiContext(
    deps.plapi.fetchInstanceConfigSchema(ctx.appId, ctx.instanceId, options.keys),
    "Failed to fetch config schema",
  );

  const json = JSON.stringify(schema, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    deps.log.success(`Schema written to ${options.output}`);
  } else {
    deps.log.data(json);
  }
}
