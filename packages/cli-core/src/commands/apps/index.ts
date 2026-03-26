import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { dim, cyan } from "../../lib/color.ts";

interface AppsOptions {
  json?: boolean;
}

function stripSecrets(apps: Application[]) {
  return apps.map((app) => ({
    application_id: app.application_id,
    name: app.name,
    instances: app.instances.map(({ secret_key: _, ...rest }) => rest),
  }));
}

function formatAppsTable(apps: Application[]): void {
  const nameWidth = Math.max(4, ...apps.map((a) => (a.name ?? a.application_id).length)) + 2;
  const idWidth = Math.max(6, ...apps.map((a) => a.application_id.length)) + 2;

  const header = `${"NAME".padEnd(nameWidth)}${"APP ID".padEnd(idWidth)}ENVIRONMENTS`;
  console.log(dim(header));

  for (const app of apps) {
    const name = (app.name ?? app.application_id).padEnd(nameWidth);
    const id = dim(app.application_id.padEnd(idWidth));
    const envs = app.instances.map((i) => i.environment_type).join(", ");
    console.log(`${cyan(name)}${id}${envs}`);
  }
}

export async function apps(options: AppsOptions = {}): Promise<void> {
  const result = await withApiContext(listApplications(), "Failed to list applications");

  if (result.length === 0) {
    console.log("No applications found. Create one at https://dashboard.clerk.com");
    return;
  }

  if (options.json || isAgent()) {
    console.log(JSON.stringify(stripSecrets(result), null, 2));
    return;
  }

  formatAppsTable(result);

  const count = result.length;
  console.error(`\n${count} application${count === 1 ? "" : "s"}`);
}
