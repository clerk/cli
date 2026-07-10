import { resolveAppContext, type AppContextOptions } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner, formatTargetSuffix } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface ConfigPullOptions extends AppContextOptions {
  output?: string;
  keys?: string[];
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
  const ctx = await resolveAppContext(options);
  await withGutter(`Pulling configuration${formatTargetSuffix(ctx.instanceLabel)}`, async () => {
    const config = await withSpinner(
      `Pulling config from ${ctx.appLabel} (${ctx.instanceLabel})...`,
      () =>
        withApiContext(
          fetchInstanceConfig(ctx.appId, ctx.instanceId, options.keys),
          "Failed to fetch config",
        ),
    );

    const json = JSON.stringify(config, null, 2);

    if (options.output) {
      await Bun.write(options.output, json + "\n");
      log.success(`Config written to ${options.output}`);
    } else {
      log.data(json);
    }
  });
}
