import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { bold, dim, cyan } from "../../lib/color.ts";

interface AppsOptions {
  json?: boolean;
  detailed?: boolean;
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

function formatAppsDetailed(apps: Application[]): void {
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i]!;
    if (i > 0) console.log("");

    console.log(bold(app.name ?? app.application_id));
    console.log(`  ${dim("App ID:")}  ${app.application_id}`);

    for (const inst of app.instances) {
      console.log(`  ${dim("Instance:")} ${inst.environment_type}`);
      console.log(`    ${dim("ID:")}              ${inst.instance_id}`);
      console.log(`    ${dim("Publishable key:")} ${inst.publishable_key}`);
      if (inst.secret_key) {
        console.log(`    ${dim("Secret key:")}      ${inst.secret_key}`);
      }
    }
  }
}

export async function apps(options: AppsOptions = {}): Promise<void> {
  const result = await withApiContext(listApplications(), "Failed to list applications");

  if (result.length === 0) {
    console.log("No applications found. Create one at https://dashboard.clerk.com");
    return;
  }

  if (options.json || isAgent()) {
    const output = options.detailed ? result : stripSecrets(result);
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (options.detailed) {
    formatAppsDetailed(result);
  } else {
    formatAppsTable(result);
  }

  const count = result.length;
  console.error(`\n${count} application${count === 1 ? "" : "s"}`);
}
