import { createApplication, fetchApplication } from "../../lib/plapi.ts";
import { UserAbortError, isPromptExitError, withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";

export async function create(name: string, options: AppsOptions = {}): Promise<void> {
  const shouldWrap = !isInsideGutter() && !options.json && !isAgent();
  if (shouldWrap) intro("Creating application");

  let nextSteps: string[] | undefined;
  let closeStatus: "success" | "failed" | "paused" | undefined;
  try {
    const app = await withSpinner("Creating application...", async () => {
      const created = await withApiContext(createApplication(name), "Failed to create application");
      return withApiContext(
        fetchApplication(created.application_id),
        "Failed to fetch application",
      );
    });

    if (printJson(stripSecrets(app), options)) {
      return;
    }

    log.blank();
    log.info(`Created ${cyan(displayName(app))} ${dim(app.application_id)}`);
    nextSteps = [
      `Run \`clerk link --app ${app.application_id}\` to connect this directory`,
      "Run `clerk env pull` to fetch your environment variables",
    ];
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
        outro(nextSteps);
      }
    }
  }
}
