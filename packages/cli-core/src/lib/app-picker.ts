/**
 * Shared interactive helpers for choosing or creating a Clerk application.
 * Used by `clerk link` and by the `clerk users` wizard fallback when no
 * project is linked and no --app was provided.
 */

import { input } from "@inquirer/prompts";
import { dim } from "./color.ts";
import { CliError, ERROR_CODE, PlapiError, withApiContext } from "./errors.ts";
import { search } from "./listage.ts";
import { log } from "./log.ts";
import {
  type Application,
  createApplication,
  fetchApplication,
  listApplications,
} from "./plapi.ts";
import { withSpinner } from "./spinner.ts";

const CREATE_NEW_APP = "__create_new__";

export function appLabel(app: Application): string {
  return app.name ? `${app.name} (${app.application_id})` : app.application_id;
}

/**
 * Fetch the user's applications. Returns an empty list when PLAPI is degraded
 * (5xx) so the caller can still offer "create a new application".
 */
export async function fetchAppsTolerantly(): Promise<Application[]> {
  try {
    return await withSpinner("Fetching applications...", () =>
      withApiContext(listApplications(), "Failed to fetch applications"),
    );
  } catch (error) {
    if (error instanceof PlapiError && error.status >= 500) {
      log.info("Could not fetch your applications, you can still create a new one");
      return [];
    }
    throw error;
  }
}

export async function pickOrCreateApp(opts: {
  apps: Application[];
  message: string;
}): Promise<Application> {
  const appChoices = opts.apps.map((a) => ({ name: appLabel(a), value: a.application_id }));
  const createChoice = { name: dim("+ Create a new application"), value: CREATE_NEW_APP };

  const selectedId = await search<string>({
    message: opts.message,
    source: (term) => {
      const filtered = term
        ? appChoices.filter((c) => c.name.toLowerCase().includes(term.toLowerCase()))
        : appChoices;
      return [createChoice, ...filtered];
    },
  });

  if (selectedId === CREATE_NEW_APP) {
    const name = await input({
      message: "Application name:",
      validate: (v) => (v.trim() ? true : "Application name cannot be empty"),
    });
    const created = await withApiContext(
      createApplication(name.trim()),
      "Failed to create application",
    );
    return withApiContext(fetchApplication(created.application_id), "Failed to fetch application");
  }

  const found = opts.apps.find((a) => a.application_id === selectedId);
  if (!found) {
    throw new CliError("Selected application not found", { code: ERROR_CODE.APP_NOT_FOUND });
  }
  return found;
}
