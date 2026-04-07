import type { Need } from "../../lib/deps.ts";
import { withApiContext } from "../../lib/errors.ts";

export type ConfigPullDeps = Need<{
  plapi: "fetchInstanceConfig";
  configStore: "resolveAppContext";
  spinner: "withSpinner";
  log: "info" | "data";
}>;

interface ConfigPullOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configPull(deps: ConfigPullDeps, options: ConfigPullOptions): Promise<void> {
  const ctx = await deps.configStore.resolveAppContext(options);

  const config = await deps.spinner.withSpinner(
    `Pulling config from ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        deps.plapi.fetchInstanceConfig(ctx.appId, ctx.instanceId, options.keys),
        "Failed to fetch config",
      ),
  );

  const json = JSON.stringify(config, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    deps.log.info(`Config written to ${options.output}`);
  } else {
    deps.log.data(json);
  }
}
