import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";
import { log } from "../../lib/log.ts";

const COLUMN_PADDING = 2;

function formatAppsTable(apps: Application[]): void {
  const nameWidth =
    Math.max("NAME".length, ...apps.map((a) => displayName(a).length)) + COLUMN_PADDING;
  const idWidth =
    Math.max("APP ID".length, ...apps.map((a) => a.application_id.length)) + COLUMN_PADDING;

  const header = `${"NAME".padEnd(nameWidth)}${"APP ID".padEnd(idWidth)}ENVIRONMENTS`;
  log.info(dim(header));

  for (const app of apps) {
    const name = displayName(app).padEnd(nameWidth);
    const id = dim(app.application_id.padEnd(idWidth));
    const envs = app.instances.map((i) => i.environment_type).join(", ");
    log.info(`${cyan(name)}${id}${envs}`);
  }
}

export async function list(options: AppsOptions = {}): Promise<void> {
  intro("Listing applications");

  const result = await withSpinner("Fetching applications...", () =>
    withApiContext(listApplications(), "Failed to list applications"),
  );

  if (printJson(result.map(stripSecrets), options)) {
    return;
  }

  log.blank()

  if (result.length === 0) {
    log.warn("No applications found. Create one at https://dashboard.clerk.com");
    outro();
    return;
  }

  formatAppsTable(result);

  const count = result.length;
  log.info(`\n${count} application${count === 1 ? "" : "s"}`);
  outro();
}
