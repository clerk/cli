import type { Need } from "../../lib/deps.ts";
import { type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { stripSecrets, displayName, type AppsOptions } from "./shared.ts";

export type AppsListDeps = Need<{
  plapi: "listApplications";
  mode: "isAgent";
  spinner: "withSpinner";
  log: "data" | "info";
}>;

const COLUMN_PADDING = 2;

function formatAppsTable(deps: Need<{ log: "data" }>, apps: Application[]): void {
  const nameWidth =
    Math.max("NAME".length, ...apps.map((a) => displayName(a).length)) + COLUMN_PADDING;
  const idWidth =
    Math.max("APP ID".length, ...apps.map((a) => a.application_id.length)) + COLUMN_PADDING;

  const header = `${"NAME".padEnd(nameWidth)}${"APP ID".padEnd(idWidth)}ENVIRONMENTS`;
  deps.log.data(dim(header));

  for (const app of apps) {
    const name = displayName(app).padEnd(nameWidth);
    const id = dim(app.application_id.padEnd(idWidth));
    const envs = app.instances.map((i) => i.environment_type).join(", ");
    deps.log.data(`${cyan(name)}${id}${envs}`);
  }
}

export async function list(deps: AppsListDeps, options: AppsOptions = {}): Promise<void> {
  const result = await deps.spinner.withSpinner("Fetching applications...", () =>
    withApiContext(deps.plapi.listApplications(), "Failed to list applications"),
  );

  if (options.json || deps.mode.isAgent()) {
    deps.log.data(JSON.stringify(result.map(stripSecrets), null, 2));
    return;
  }

  if (result.length === 0) {
    deps.log.info("No applications found. Create one at https://dashboard.clerk.com");
    return;
  }

  formatAppsTable(deps, result);

  const count = result.length;
  deps.log.info(`\n${count} application${count === 1 ? "" : "s"}`);
}
