import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { dim, cyan } from "../../lib/color.ts";

interface AppsListOptions {
  json?: boolean;
}

const COLUMN_PADDING = 2;

const displayName = (app: Application) => app.name ?? app.application_id;

function stripSecrets(apps: Application[]) {
  return apps.map(({ instances, ...app }) => ({
    ...app,
    instances: instances.map(({ secret_key: _, ...rest }) => rest),
  }));
}

function formatAppsTable(apps: Application[]): void {
  const nameWidth =
    Math.max("NAME".length, ...apps.map((a) => displayName(a).length)) + COLUMN_PADDING;
  const idWidth =
    Math.max("APP ID".length, ...apps.map((a) => a.application_id.length)) + COLUMN_PADDING;

  const header = `${"NAME".padEnd(nameWidth)}${"APP ID".padEnd(idWidth)}ENVIRONMENTS`;
  console.log(dim(header));

  for (const app of apps) {
    const name = displayName(app).padEnd(nameWidth);
    const id = dim(app.application_id.padEnd(idWidth));
    const envs = app.instances.map((i) => i.environment_type).join(", ");
    console.log(`${cyan(name)}${id}${envs}`);
  }
}

export async function list(options: AppsListOptions = {}): Promise<void> {
  const result = await withApiContext(listApplications(), "Failed to list applications");

  if (options.json || isAgent()) {
    console.log(JSON.stringify(stripSecrets(result), null, 2));
    return;
  }

  if (result.length === 0) {
    console.log("No applications found. Create one at https://dashboard.clerk.com");
    return;
  }

  formatAppsTable(result);

  const count = result.length;
  console.error(`\n${count} application${count === 1 ? "" : "s"}`);
}
