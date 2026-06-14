import { createApplication, fetchApplication, listApplications } from "../../lib/plapi.ts";
import { UserAbortError, isPromptExitError, withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { stripSecrets, displayName, printJson, type AppsOptions } from "./shared.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

interface CreateOptions extends AppsOptions {
  ifNotExists?: boolean;
}

export async function create(name: string, options: CreateOptions = {}): Promise<void> {
  const shouldWrap = !isInsideGutter() && !options.json && !isAgent();
  if (shouldWrap) intro("Creating application");

  if (options.ifNotExists) {
    const existing = await withSpinner("Looking up existing application...", () =>
      withApiContext(listApplications(), "Failed to list applications"),
    );
    const match = existing.find((a) => a.name === name);
    if (match) {
      const full = await withApiContext(
        fetchApplication(match.application_id),
        "Failed to fetch application",
      );
      if (printJson({ ...stripSecrets(full), reused: true }, options)) return;
      log.info(`Reusing ${cyan(displayName(full))} ${dim(full.application_id)}`);
      if (shouldWrap) outro(NEXT_STEPS.CREATE);
      return;
    }
  }

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
