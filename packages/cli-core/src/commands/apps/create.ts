import { createApplication, fetchApplication } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { printNextSteps, NEXT_STEPS } from "../../lib/next-steps.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";

export async function create(name: string, options: AppsOptions = {}): Promise<void> {
  const app = await withSpinner("Creating application...", async () => {
    const created = await withApiContext(createApplication(name), "Failed to create application");
    return withApiContext(fetchApplication(created.application_id), "Failed to fetch application");
  });

  if (printJson(stripSecrets(app), options)) return;

  console.log(`Created ${cyan(displayName(app))} ${dim(app.application_id)}`);
  printNextSteps(NEXT_STEPS.CREATE);
}
