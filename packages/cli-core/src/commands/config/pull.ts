import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";

interface ConfigPullOptions {
  app?: string;
  instance?: string;
  output?: string;
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  console.error(`Pulling config from ${ctx.appLabel} (${ctx.instanceLabel})...`);

  const config = await withApiContext(
    fetchInstanceConfig(ctx.appId, ctx.instanceId),
    "Failed to fetch config",
  );
  const json = JSON.stringify(config, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    console.error(`Config written to ${options.output}`);
  } else {
    console.log(json);
  }
}
