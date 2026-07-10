import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withGutter, formatTargetSuffix } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  const ctx = await resolveAppContext(options);
  await withGutter(
    `Fetching configuration schema${formatTargetSuffix(ctx.instanceLabel)}`,
    async () => {
      log.info(`Pulling config schema from ${ctx.appLabel} (${ctx.instanceLabel})...`);

      const schema = await withApiContext(
        fetchInstanceConfigSchema(ctx.appId, ctx.instanceId, options.keys),
        "Failed to fetch config schema",
      );

      const json = JSON.stringify(schema, null, 2);

      if (options.output) {
        await Bun.write(options.output, json + "\n");
        log.success(`Schema written to ${options.output}`);
      } else {
        log.data(json);
      }
    },
  );
}
