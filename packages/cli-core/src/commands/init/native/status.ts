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
