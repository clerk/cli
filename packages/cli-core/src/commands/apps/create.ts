import { createApplication, fetchApplication } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";
import { log } from "../../lib/log.ts";

export async function create(name: string, options: AppsOptions = {}): Promise<void> {
  intro("Creating application");

  const app = await withSpinner("Creating application...", async () => {
    const created = await withApiContext(createApplication(name), "Failed to create application");
    return withApiContext(fetchApplication(created.application_id), "Failed to fetch application");
  });

  if (printJson(stripSecrets(app), options)) {
    outro();
    return;
  }

  log.info(`Created ${cyan(displayName(app))} ${dim(app.application_id)}`);
  outro([
    `Run \`clerk link --app ${app.application_id}\` to connect this directory`,
    "Run `clerk env pull` to fetch your environment variables",
  ]);
}
