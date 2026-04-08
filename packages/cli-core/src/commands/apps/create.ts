import { createApplication, fetchApplication, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner } from "../../lib/spinner.ts";

interface AppsCreateOptions {
  json?: boolean;
}

function stripSecrets(app: Application) {
  return {
    ...app,
    instances: app.instances.map(({ secret_key: _, ...rest }) => rest),
  };
}

export async function create(name: string, options: AppsCreateOptions = {}): Promise<void> {
  const app = await withSpinner("Creating application...", async () => {
    const created = await withApiContext(createApplication(name), "Failed to create application");
    return withApiContext(fetchApplication(created.application_id), "Failed to fetch application");
  });

  if (options.json || isAgent()) {
    console.log(JSON.stringify(stripSecrets(app), null, 2));
    return;
  }

  const label = app.name ?? app.application_id;
  console.log(`Created ${cyan(label)} ${dim(app.application_id)}`);
}
