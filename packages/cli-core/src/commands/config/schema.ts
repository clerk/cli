import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withGutter } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { resolveKeylessTarget } from "../../lib/keyless-target.ts";

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  await withGutter("Fetching configuration schema", async () => {
    if (await resolveKeylessTarget(options)) {
      throw new CliError(
        "Config schema is only available for a claimed application — the schema describes the account-level config document, which an unclaimed keyless application has no access to.\n" +
          "Run `clerk auth login` to claim this application, then re-run `clerk config schema`.",
        { code: ERROR_CODE.AUTH_REQUIRED },
      );
    }

    const ctx = await resolveAppContext(options);

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
