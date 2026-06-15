import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { stringify as stringifyYaml } from "yaml";

interface ConfigPullOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
  json?: boolean;
}

// Resolve output format: --json wins; else a .json output path stays JSON;
// otherwise default to YAML (stdout, .yaml, .yml, extensionless).
function useJsonOutput(options: ConfigPullOptions): boolean {
  if (options.json) return true;
  if (options.output && options.output.toLowerCase().endsWith(".json")) return true;
  return false;
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
  await withGutter("Pulling configuration", async () => {
    const ctx = await resolveAppContext(options);

    const config = await withSpinner(
      `Pulling config from ${ctx.appLabel} (${ctx.instanceLabel})...`,
      () =>
        withApiContext(
          fetchInstanceConfig(ctx.appId, ctx.instanceId, options.keys),
          "Failed to fetch config",
        ),
    );

    const serialized = useJsonOutput(options)
      ? JSON.stringify(config, null, 2)
      : stringifyYaml(config);

    if (options.output) {
      await Bun.write(options.output, serialized.endsWith("\n") ? serialized : serialized + "\n");
      log.success(`Config written to ${options.output}`);
    } else {
      log.data(serialized);
    }
  });
}
