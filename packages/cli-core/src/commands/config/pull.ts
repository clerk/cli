import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { resolveInstanceTarget } from "../../lib/keyless-target.ts";
import { pullKeylessConfig } from "./keyless.ts";

interface ConfigPullOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
  await withGutter("Pulling configuration", async () => {
    const target = await resolveInstanceTarget(options);

    const config = await withSpinner(`Pulling config from ${target.label}...`, async () =>
      target.kind === "keyless"
        ? pullKeylessConfig(target.keyless, options.keys)
        : withApiContext(
            fetchInstanceConfig(target.ctx.appId, target.ctx.instanceId, options.keys),
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
