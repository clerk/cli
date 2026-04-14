import type { Need } from "../../lib/deps.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { printNextSteps, NEXT_STEPS } from "../../lib/next-steps.ts";
import { stripSecrets, displayName, type AppsOptions } from "./shared.ts";

export type AppsCreateDeps = Need<{
  plapi: "createApplication" | "fetchApplication";
  mode: "isAgent";
  spinner: "withSpinner";
  log: "info" | "success" | "data" | "blank";
}>;

export async function create(
  deps: AppsCreateDeps,
  name: string,
  options: AppsOptions = {},
): Promise<void> {
  const app = await deps.spinner.withSpinner("Creating application...", async () => {
    const created = await withApiContext(
      deps.plapi.createApplication(name),
      "Failed to create application",
    );
    return withApiContext(
      deps.plapi.fetchApplication(created.application_id),
      "Failed to fetch application",
    );
  });

  if (options.json || deps.mode.isAgent()) {
    deps.log.data(JSON.stringify(stripSecrets(app), null, 2));
    return;
  }

  deps.log.success(`Created ${cyan(displayName(app))} ${dim(app.application_id)}`);
  printNextSteps(deps, NEXT_STEPS.CREATE);
}
