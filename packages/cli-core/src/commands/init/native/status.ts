import { errorMessage } from "../../../lib/errors.ts";

/**
 * What an agent needs to do before native setup can run: choose a Clerk application, then run
 * `command`, which carries this run's setup options. `project` names what setup configures.
 */
export function applicationRequired<Starter extends object>(
  command = "clerk init --app <app_id> --json",
  project: "Xcode project" | "Android project" = "Xcode project",
  starter?: Starter,
) {
  return {
    status: "application-required",
    appIntegrationComplete: false,
    ...(starter && { starter }),
    next: [
      'Run `clerk apps list --json` and ask the user which application to use, or create one with `clerk apps create "<name>" --json`. If listing fails because you are not signed in, run `clerk auth login` first.',
      `Then run \`${command}\` to link it, configure the ${project}, and register the app with Clerk.`,
    ],
  };
}

export interface StarterProjectSummary {
  projectName: string;
  platform: "ios" | "macos" | "android";
  /** Where the new app was written. */
  projectDir?: string;
  /** The `clerk init` that finishes setting up the new app, run from where the starter ran. */
  continuation?: string;
}

/**
 * A new app was written, but setup stopped with an error that has no status of its own. Running
 * `--starter` again would refuse the existing folder, so the agent continues inside the new app.
 */
export function setupInterrupted(starter: StarterProjectSummary, error: unknown) {
  return {
    status: "setup-interrupted",
    appIntegrationComplete: false,
    error: errorMessage(error),
    starter,
    next: [
      `Resolve the error, then run \`${starter.continuation}\` to finish setting up the new app. Don't run --starter again.`,
    ],
  };
}
