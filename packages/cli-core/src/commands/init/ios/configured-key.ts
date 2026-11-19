import type * as plapi from "../../../lib/plapi.ts";
import { CliError, ERROR_CODE, EXIT_CODE, errorMessage } from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { configuredPublishableKey, scanSwiftSources } from "./publishable-key.ts";
import type { NativeAPI } from "./remote.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Before setup changes anything, checks that the publishable key the app passes to
 * `Clerk.configure` belongs to the linked application. A repository's link is shared by every
 * project in it, so an app built against another application would otherwise get its Bundle ID
 * registered, and Native API enabled, on an application it never signs in to. Only a key the CLI
 * can read (see publishable-key.ts) that matches none of the linked application's instances
 * stops setup; a key it can't read is reported as unverified, never guessed.
 */

export type ConfiguredKeyCheck =
  | {
      status: "verified";
      configuration: string;
      /** Which of the linked application's instances the key belongs to. */
      instance: "development" | "production";
      source: string;
    }
  | { status: "unverified"; configuration: string; reason: string };

export interface KeyOwner {
  appId: string;
  appName?: string;
}

export interface KeyCheckAPI {
  fetchApplication: NativeAPI["fetchApplication"];
  /** Names the application a mismatched key belongs to; without it the stop can't name one. */
  listApplications?: typeof plapi.listApplications;
}

/** The linked application, as the link records it. */
export interface LinkedApplication {
  appId: string;
  appName?: string;
  /** What the link covers: the Git repository, or else the linked folder. */
  scope: string;
}

/** The app's key belongs to another application; with `--json` it's reported as `input-required`. */
export class PublishableKeyMismatch extends CliError {
  constructor(
    message: string,
    readonly details: {
      configuration: string;
      source: string;
      frontendApiHost: string;
      owner?: KeyOwner;
    },
  ) {
    super(message, { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE });
  }
}

function frontendHost(key: string): string | undefined {
  try {
    return decodePublishableKey(key).fapiHost.toLowerCase();
  } catch {
    return undefined;
  }
}

function display(app: { appId: string; appName?: string }): string {
  return app.appName ? `${app.appName} (${app.appId})` : app.appId;
}

/** The application among the user's that has an instance with this Frontend API host. */
async function findOwner(host: string, api: KeyCheckAPI): Promise<KeyOwner | undefined> {
  if (!api.listApplications) return undefined;
  try {
    const owner = (await api.listApplications()).find((application) =>
      application.instances.some((instance) => frontendHost(instance.publishable_key) === host),
    );
    return owner && { appId: owner.application_id, ...(owner.name && { appName: owner.name }) };
  } catch {
    // Naming the owner is a courtesy; the mismatch itself is already certain.
    return undefined;
  }
}

/**
 * Checks the configuration setup targets first (Debug, or `--xcode-configuration`), which
 * runs against the development instance. Throws `PublishableKeyMismatch` when its key belongs
 * to no instance of the linked application. A production key of the linked application is
 * reported as verified with `instance: "production"`, not as a mismatch.
 */
export async function checkConfiguredKey(
  inspection: Inspection,
  linked: LinkedApplication,
  api: KeyCheckAPI,
  relinkCommand: (appId: string) => string,
): Promise<ConfiguredKeyCheck> {
  const context = inspection.contexts[0]!;
  const configuration = context.selection.configuration;
  const configured = await configuredPublishableKey(context, await scanSwiftSources(inspection));
  if (configured.status === "unresolved")
    return { status: "unverified", configuration, reason: configured.reason };
  const host = frontendHost(configured.key);
  if (!host)
    return {
      status: "unverified",
      configuration,
      reason: `the publishable key in ${configured.source} could not be decoded`,
    };
  let application: plapi.Application;
  try {
    application = await api.fetchApplication(linked.appId, { includeSecretKeys: false });
  } catch (error) {
    return {
      status: "unverified",
      configuration,
      reason: `the linked application could not be read: ${errorMessage(error)}`,
    };
  }
  const instance = application.instances.find(
    (candidate) => frontendHost(candidate.publishable_key) === host,
  );
  if (instance)
    return {
      status: "verified",
      configuration,
      instance: instance.environment_type === "production" ? "production" : "development",
      source: configured.source,
    };

  const owner = await findOwner(host, api);
  const current = display(linked);
  const target = context.selection.targetName;
  // Keys are compared, never printed; the Frontend API host is public and identifies the instance.
  const belongs = owner
    ? `belongs to ${display(owner)}`
    : `belongs to none of its instances (its Frontend API is ${host}, an application this account can't see or that no longer exists)`;
  const fix = owner
    ? `To set up ${display(owner)} instead, run \`${relinkCommand(owner.appId)}\` (this switches the link for every project in ${linked.scope}). To keep ${current}, pass its development publishable key to Clerk.configure, then rerun clerk init.`
    : `Pass ${current}'s development publishable key to Clerk.configure and rerun clerk init, or run \`${relinkCommand("<app_id>")}\` with the application the key belongs to (this switches the link for every project in ${linked.scope}).`;
  throw new PublishableKeyMismatch(
    `${linked.scope} is linked to ${current}, but ${target} (${configuration}) passes Clerk.configure a publishable key (from ${configured.source}) that ${belongs}. Setting up ${current} would register this app on an application it doesn't sign in to, so nothing was changed. ${fix}`,
    {
      configuration,
      source: configured.source,
      frontendApiHost: host,
      ...(owner && { owner }),
    },
  );
}

/** The `input-required` status an agent gets for a mismatch, shaped like init's other link stops. */
export function describeMismatch(
  error: PublishableKeyMismatch,
  linked: LinkedApplication,
  relinkCommand: (appId: string) => string,
) {
  const { owner, configuration, source, frontendApiHost } = error.details;
  const current = display(linked);
  return {
    status: "input-required",
    appIntegrationComplete: false,
    link: {
      flag: "--relink",
      question: owner
        ? `This app is configured with ${display(owner)}'s publishable key, but ${linked.scope} is linked to ${current}. Switch the link to ${display(owner)}, or keep ${current} and change the app's key?`
        : `This app is configured with a publishable key from an application other than ${current}, which ${linked.scope} is linked to. Which application should it use?`,
      issue: error.message,
      current: { appId: linked.appId, ...(linked.appName && { appName: linked.appName }) },
      ...(owner && { requested: owner.appId }),
      scope: linked.scope,
      publishableKey: {
        configuration,
        source,
        frontendApiHost,
        ...(owner && { application: owner }),
      },
    },
    next: [
      owner
        ? `If the user wants ${display(owner)}, run \`${relinkCommand(owner.appId)}\`.`
        : `If the user names the application the key belongs to, run \`${relinkCommand("<app_id>")}\` with it.`,
      `If the user wants to keep ${current}, change the key Clerk.configure gets (from ${source}) to ${current}'s development publishable key (\`clerk apps list --json\` lists it), then rerun clerk init.`,
    ],
  };
}
