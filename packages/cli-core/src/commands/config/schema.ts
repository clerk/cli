import { fetchInstanceConfigSchema } from "../../lib/plapi.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withGutter } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { keylessCopy } from "../../lib/copy.ts";
import { resolveInstanceTarget } from "../../lib/keyless-target.ts";
import { keylessRefusal, type Rerun } from "../../lib/unlinked-folder.ts";
import { quoteArg } from "../../lib/json-body.ts";

interface ConfigSchemaOptions {
  app?: string;
  instance?: string;
  output?: string;
  keys?: string[];
}

/** `clerk config schema` with the run's own flags, shell-quoted; the keyless path takes no others. */
function schemaRerun({ keys, output }: ConfigSchemaOptions): Rerun {
  const command = [
    "clerk config schema",
    keys?.length && `--keys ${keys.map(quoteArg).join(" ")}`,
    output && `--output ${quoteArg(output)}`,
  ]
    .filter(Boolean)
    .join(" ");
  return { clause: `run \`${command}\` again`, command };
}

export async function configSchema(options: ConfigSchemaOptions): Promise<void> {
  await withGutter("Fetching configuration schema", async () => {
    // Same shape as config push/put: resolve the target once, branch on kind.
    const target = await resolveInstanceTarget(options);
    if (target.kind === "keyless") {
      const { subject, step, examples } = keylessRefusal(
        target.folder,
        target.keyless.source,
        schemaRerun(options),
      );
      throw new CliError(keylessCopy.schemaNeedsClaimedApplication(subject, step), {
        code: ERROR_CODE.AUTH_REQUIRED,
        examples,
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
