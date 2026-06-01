import { listApplications, type Application } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { UserAbortError, isPromptExitError } from "../../lib/errors.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { ui } from "../../lib/ui.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";
import { isAgent } from "../../mode.ts";

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
  const shouldWrap = !options.json && !isAgent();
  if (shouldWrap) intro("Listing applications");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const fetchApps = () => withApiContext(listApplications(), "Failed to list applications");
    const result = shouldWrap
      ? await withSpinner("Fetching applications...", fetchApps)
      : await fetchApps();

    if (printJson(result.map(stripSecrets), options)) {
      return;
    }

    if (result.length === 0) {
      ui.warn("No applications found. Create one at https://dashboard.clerk.com");
      closeStatus = "success";
      return;
    }

    formatAppsTable(result);

    const count = result.length;
    ui.message(`${count} application${count === 1 ? "" : "s"}`);
    closeStatus = "success";
  } catch (error) {
    closeStatus = error instanceof UserAbortError || isPromptExitError(error) ? "paused" : "failed";
    throw error;
  } finally {
    if (shouldWrap) {
      if (closeStatus === "paused") {
        pausedOutro();
      } else if (closeStatus === "failed") {
        outro("Failed");
      } else if (closeStatus === "success") {
        outro();
      }
    }
  }
}
