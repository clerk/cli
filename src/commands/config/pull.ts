import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { CliError } from "../../lib/errors.ts";

interface ConfigPullOptions {
  instance?: string;
  output?: string;
}

export async function configPull(options: ConfigPullOptions): Promise<void> {
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` to set up.");
  }

  const { profile } = resolved;
  const instance = resolveInstanceId(profile, options.instance);

  console.error(`Pulling config from ${instance.label} instance...`);

  const config = await fetchInstanceConfig(profile.appId, instance.id);
  const json = JSON.stringify(config, null, 2);

  if (options.output) {
    await Bun.write(options.output, json + "\n");
    console.error(`Config written to ${options.output}`);
  } else {
    console.log(json);
  }
}
