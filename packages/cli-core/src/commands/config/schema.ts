import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withGutter } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { keylessCopy } from "../../lib/copy.ts";
import { resolveInstanceTarget } from "../../lib/keyless-target.ts";

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  await withGutter("Fetching configuration schema", async () => {
    // Same shape as config push/put: resolve the target once, branch on kind.
    const target = await resolveInstanceTarget(options);
    if (target.kind === "keyless") {
      throw new CliError(keylessCopy.schemaNeedsClaimedApplication(), {
        code: ERROR_CODE.AUTH_REQUIRED,
      });
    }

    const ctx = target.ctx;

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
  });
}
