import type * as plapi from "../../../lib/plapi.ts";
import { profileLabel } from "../../../lib/config.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { configuredPublishableKey, scanSwiftSources } from "./publishable-key.ts";
import type { InstanceEnvironment, NativeAPI } from "./remote.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Before setup changes the project or Clerk, checks that the publishable key the app passes to
 * `Clerk.configure` belongs to the linked application. A repository's link is shared by every
 * project in it, so an app built against another application would otherwise get its Bundle ID
 * registered, and Native API enabled, on an application it never signs in to. Only a key the CLI
 * can read (see publishable-key.ts) that clearly belongs elsewhere stops setup; a key it can't
 * read is reported as unverified, never guessed.
 */

export type ConfiguredKeyCheck =
  | {
      status: "verified";
      configuration: string;
      /** Which of the linked application's instances the key belongs to. */
      instance: InstanceEnvironment;
      source: string;
    }
  | { status: "unverified"; configuration: string; reason: string };

export interface KeyOwner {
  appId: string;
  appName?: string;
}

/** The linked application, as the link records it. */
export interface LinkedApplication {
  appId: string;
  appName?: string;
  /** What the link covers: the Git repository, or else the linked folder. */
  scope: string;
  /** What running the relink command does to the link, such as "this switches the link for every project in /repo". */
  relinkEffect: string;
}

/** The `clerk init` that relinks to `appId` (`<app_id>` when unknown), carrying this run's setup options. */
export type RetryCommand = (appId?: string) => string;

/** A configuration whose key belongs to another application than the link. */
export interface MismatchedKey {
  configuration: string;
  source: string;
  frontendApiHost: string;
  /** The key that keeps the linked application here, such as "Linked (app_123)'s production publishable key". */
  replacement: string;
  /** The key's application, when it's among the applications the CLI can list. */
  application?: KeyOwner;
}

/** The app's keys belong to another application; with `--json` it's reported as `input-required`. */
export class PublishableKeyMismatch extends CliError {
  constructor(
    message: string,
    readonly details: {
      keys: MismatchedKey[];
      /**
       * Every configuration's key was read, and they're all the same key or keys of the same known
       * application, so relinking resolves it. `application` is that application, when known.
       */
      relink?: { application?: KeyOwner };
      /** A configuration whose key belongs to the linked application. */
      matching?: string;
      /** Configurations whose key couldn't be read. */
      unverified: string[];
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

/** Finds which of the user's applications has an instance with a Frontend API host, listing them once. */
function ownerLookup(api: NativeAPI) {
  let listed: Promise<plapi.Application[] | undefined> | undefined;
  return async (host: string): Promise<KeyOwner | undefined> => {
    // Naming the owner is a courtesy; a failed listing leaves it unnamed.
    listed ??= api.listApplications().catch(() => undefined);
    const owner = (await listed)?.find((application) =>
      application.instances.some((instance) => frontendHost(instance.publishable_key) === host),
    );
    return owner && { appId: owner.application_id, ...(owner.name && { appName: owner.name }) };
  };
}

/**
 * Checks every configuration setup changes (Debug and Release, or `--xcode-configuration`), all
 * of which it sets up against the development instance. Throws `PublishableKeyMismatch` when a
 * configuration's key belongs to no instance of the linked application, naming every such
 * configuration. A production key of the linked application is verified with
 * `instance: "production"`, not a mismatch. A failure to read the linked application propagates:
 * setup can't continue without it anyway.
 */
export async function checkConfiguredKeys(
  inspection: Inspection,
  linked: LinkedApplication,
  api: NativeAPI,
  retryCommand: RetryCommand,
): Promise<ConfiguredKeyCheck[]> {
  const scan = await scanSwiftSources(inspection);
  const findOwner = ownerLookup(api);
  let application: plapi.Application | undefined;
  const checks: ConfiguredKeyCheck[] = [];
  const mismatched: MismatchedKey[] = [];
  for (const context of inspection.contexts) {
    const configuration = context.selection.configuration;
    const configured = await configuredPublishableKey(context, scan);
    if (configured.status === "unresolved") {
      checks.push({ status: "unverified", configuration, reason: configured.reason });
      continue;
    }
    let host: string;
    let environment: InstanceEnvironment;
    try {
      const key = decodePublishableKey(configured.key);
      host = key.fapiHost.toLowerCase();
      environment = key.instanceType;
    } catch {
      checks.push({
        status: "unverified",
        configuration,
        reason: `the publishable key in ${configured.source} could not be decoded`,
      });
      continue;
    }
    application ??= await api.fetchApplication(linked.appId, { includeSecretKeys: false });
    const instance = application.instances.find(
      (candidate) => frontendHost(candidate.publishable_key) === host,
    );
    if (instance) {
      checks.push({
        status: "verified",
        configuration,
        instance: instance.environment_type === "production" ? "production" : "development",
        source: configured.source,
      });
      continue;
    }
    const owner = await findOwner(host);
    const current = profileLabel(linked);
    mismatched.push({
      configuration,
      source: configured.source,
      frontendApiHost: host,
      // Keep the configuration on the environment it already uses: a release build stays on production.
      replacement: application.instances.some(
        (candidate) => candidate.environment_type === environment,
      )
        ? `${current}'s ${environment} publishable key`
        : `a publishable key of ${current} (it has no ${environment} instance yet)`,
      ...(owner && { application: owner }),
    });
  }
  if (!mismatched.length) return checks;
  const matching = checks.find((check) => check.status === "verified")?.configuration;
  const unverified = checks.flatMap((check) =>
    check.status === "unverified" ? [check.configuration] : [],
  );
  // Relinking is offered only when it's sure to satisfy every configuration: each one mismatched
  // (none uses the link or went unchecked), with the same key (one Frontend API host) or keys of
  // the same known application. Keys of an unlisted application with different hosts may belong
  // to one application or two, so they're never assumed to.
  const owners = new Set(
    mismatched.map((key) => key.application?.appId ?? `host:${key.frontendApiHost}`),
  );
  const relink =
    !checks.length && owners.size === 1 ? { application: mismatched[0]!.application } : undefined;
  throw new PublishableKeyMismatch(
    mismatchMessage(inspection, linked, mismatched, relink, matching, unverified, retryCommand),
    { keys: mismatched, ...(relink && { relink }), ...(matching && { matching }), unverified },
  );
}

/** "Debug (from a string literal in App.swift) belongs to Other (app_other)", for each key. */
/** Configurations that share a value, such as one string literal read by Debug and Release, listed once. */
function grouped(keys: MismatchedKey[], by: (key: MismatchedKey) => string) {
  const groups = new Map<string, { key: MismatchedKey; configurations: string[] }>();
  for (const key of keys) {
    const group = groups.get(by(key));
    if (group) group.configurations.push(key.configuration);
    else groups.set(by(key), { key, configurations: [key.configuration] });
  }
  return [...groups.values()].map(({ key, configurations }) => ({
    key,
    configurations: configurations.join(" and "),
  }));
}

/** "Debug and Release (from a string literal in App.swift) belongs to Other (app_other)", once per key. */
function describeKeys(keys: MismatchedKey[]): string {
  // Keys are compared, never printed; the Frontend API host is public and identifies the instance.
  return grouped(keys, (key) => `${key.source}\n${key.frontendApiHost}`)
    .map(
      ({ key, configurations }) =>
        `${configurations} (from ${key.source}) belongs to ${
          key.application
            ? profileLabel(key.application)
            : `an application whose Frontend API is ${key.frontendApiHost}, which isn't among the applications the CLI could list`
        }`,
    )
    .join("; and in ");
}

function replacements(keys: MismatchedKey[]): string {
  return grouped(keys, (key) => key.replacement)
    .map(({ key, configurations }) => `the key for ${configurations} to ${key.replacement}`)
    .join(", and ");
}

function mismatchMessage(
  inspection: Inspection,
  linked: LinkedApplication,
  keys: MismatchedKey[],
  relink: { application?: KeyOwner } | undefined,
  matching: string | undefined,
  unverified: string[],
  retryCommand: RetryCommand,
): string {
  const current = profileLabel(linked);
  const target = inspection.input.selection.targetName;
  const found = `${linked.scope} is linked to ${current}, but the publishable key ${target} passes to Clerk.configure in ${describeKeys(keys)}.`;
  const keep = `change ${replacements(keys)}, then rerun clerk init`;
  if (relink) {
    const owner = relink.application;
    return `${found} Setting up ${current} would register this app on an application it doesn't sign in to, so no setup was applied. ${
      owner
        ? `To set up ${profileLabel(owner)} instead, run \`${retryCommand(owner.appId)}\` (${linked.relinkEffect}). To keep ${current}, ${keep}.`
        : `To keep ${current}, ${keep}. Or run \`${retryCommand()}\` with the application the key belongs to (${linked.relinkEffect}).`
    }`;
  }
  const uses = `${matching ? ` ${matching} uses ${current}'s key.` : ""}${
    unverified.length
      ? ` ${unverified.join(", ")}'s key couldn't be checked, so which application it uses isn't known.`
      : ""
  }`;
  return `${found}${uses} clerk init sets up one application for every configuration it changes, so no setup was applied. To keep ${current}, ${keep}.`;
}

/** The `input-required` status an agent gets for a mismatch, shaped like init's other link stops. */
export function describeMismatch(
  error: PublishableKeyMismatch,
  linked: LinkedApplication,
  retryCommand: RetryCommand,
) {
  const { keys, relink, unverified } = error.details;
  const current = profileLabel(linked);
  const owner = relink?.application;
  const keep = `If the user wants to keep ${current}, change ${replacements(keys)} where Clerk.configure gets it (\`clerk apps list --json\` lists the keys), then rerun clerk init.`;
  return {
    status: "input-required",
    appIntegrationComplete: false,
    link: {
      ...(relink && { flag: "--relink" }),
      question: relink
        ? owner
          ? `This app is configured with ${profileLabel(owner)}'s publishable key, but ${linked.scope} is linked to ${current}. Switch the link to ${profileLabel(owner)}, or keep ${current} and change the app's key?`
          : `This app is configured with a publishable key from an application other than ${current}, which ${linked.scope} is linked to. Which application should it use?`
        : unverified.length
          ? `${keys.map((key) => key.configuration).join(", ")} use${keys.length === 1 ? "s" : ""} a publishable key from an application other than ${current}, which ${linked.scope} is linked to, and ${unverified.join(", ")}'s key couldn't be checked. Which application should the app use?`
          : `This app's configurations use publishable keys from different applications, and ${linked.scope} is linked to ${current}. Which application should the app use?`,
      issue: error.message,
      current: { appId: linked.appId, ...(linked.appName && { appName: linked.appName }) },
      ...(owner && { requested: owner.appId }),
      scope: linked.scope,
      publishableKeys: keys.map(({ configuration, source, frontendApiHost, application }) => ({
        configuration,
        source,
        frontendApiHost,
        ...(application && { application }),
      })),
    },
    next: relink
      ? [
          owner
            ? `If the user wants ${profileLabel(owner)}, run \`${retryCommand(owner.appId)}\`.`
            : `If the user names the application the key belongs to, run \`${retryCommand()}\` with it.`,
          keep,
        ]
      : [
          "clerk init sets up one application for all the configurations it changes, so ask the user which application the app should use.",
          keep,
        ],
  };
}
