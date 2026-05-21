import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
import { ui } from "../../lib/ui.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";

const COLUMN_PADDING = 2;

function formatAppsTable(apps: Application[]): void {
  const nameWidth =
    Math.max("NAME".length, ...apps.map((a) => displayName(a).length)) + COLUMN_PADDING;
  const idWidth =
    Math.max("APP ID".length, ...apps.map((a) => a.application_id.length)) + COLUMN_PADDING;

  const header = `${"NAME".padEnd(nameWidth)}${"APP ID".padEnd(idWidth)}ENVIRONMENTS`;
  const rows = apps.map((app) => {
    const name = displayName(app).padEnd(nameWidth);
    const id = dim(app.application_id.padEnd(idWidth));
    const envs = app.instances.map((i) => i.environment_type).join(", ");
    return `${cyan(name)}${id}${envs}`;
  });

  ui.message([dim(header), ...rows]);
}

export async function list(options: AppsOptions = {}): Promise<void> {
  intro("Listing applications");

  const result = await withSpinner("Fetching applications...", () =>
    withApiContext(listApplications(), "Failed to list applications"),
  );

  if (printJson(result.map(stripSecrets), options)) {
    return;
  }

  if (result.length === 0) {
    ui.warn("No applications found. Create one at https://dashboard.clerk.com");
    outro();
    return;
  }

  formatAppsTable(result);

  const count = result.length;
  ui.message(`${count} application${count === 1 ? "" : "s"}`);
  outro();
}
