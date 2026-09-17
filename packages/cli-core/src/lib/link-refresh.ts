/**
 * Reconciling a stored link with the instances an application actually has.
 *
 * `clerk link` records instance IDs once (`commands/link/index.ts`), so an
 * instance created afterwards — most often a production instance added in the
 * Dashboard — is invisible to every command that resolves through the stored
 * profile. `resolveInstanceId` reads that snapshot with no network call and
 * reports "No production instance configured", which is indistinguishable from
 * an application that genuinely has none.
 *
 * This module is the one place that tells those two states apart, by asking
 * the API before choosing a remedy. It deliberately owns no intro/outro
 * brackets: `env pull` and friends call it from inside an open `withGutter`,
 * and a nested `intro()` would double the gutter.
 */

import { instanceAliasEnv, resolveInstanceId, setProfile, type Profile } from "./config.ts";
import { CliError, ERROR_CODE, withApiContext } from "./errors.ts";
import { log } from "./log.ts";
import { isAgent } from "../mode.ts";
import { confirm } from "./prompts.ts";
import { fetchApplication, type Application } from "./plapi.ts";

export type InstanceEnv = "development" | "production";

export interface RefreshResult {
  profile: Profile;
  /** Environments whose recorded instance ID the refresh added, changed, or dropped. */
  updated: InstanceEnv[];
  /** Whether the stored app name was rewritten to match the API. */
  renamed: boolean;
}

const DOCS_URL = "https://clerk.com/docs/guides/development/managing-environments";

/** Fetch the application a profile points at. */
export async function fetchLinkedApplication(profile: Profile): Promise<Application> {
  return withApiContext(fetchApplication(profile.appId), "Failed to fetch application");
}

function instanceIdFor(app: Application, env: InstanceEnv): string | undefined {
  return app.instances.find((instance) => instance.environment_type === env)?.instance_id;
}

/**
 * Write the application's current instance IDs into the stored profile.
 * Takes an already-fetched `app` so callers that needed it to decide whether
 * to refresh don't pay for a second round trip.
 */
export async function refreshProfileInstances(
  profileKey: string,
  profile: Profile,
  app: Application,
): Promise<RefreshResult> {
  // An application always has a development instance; if the response somehow
  // omits it, keep the recorded one rather than corrupting the profile.
  const development = instanceIdFor(app, "development") ?? profile.instances.development;
  const production = instanceIdFor(app, "production");

  const updated: InstanceEnv[] = [];
  if (development !== profile.instances.development) updated.push("development");
  if (production !== profile.instances.production) updated.push("production");

  const refreshed: Profile = {
    ...profile,
    appName: app.name ?? profile.appName,
    instances: { development, ...(production ? { production } : {}) },
  };

  // The returned profile carries the fetched app name, so persist on a rename
  // too — otherwise callers report a name that never reached disk.
  const renamed = refreshed.appName !== profile.appName;
  if (updated.length > 0 || renamed) {
    await setProfile(profileKey, refreshed);
    log.debug(`config: refreshed instances for ${profile.appId} (${updated.join(", ") || "name"})`);
  }

  return { profile: refreshed, updated, renamed };
}

function missingUpstream(env: InstanceEnv, appId: string): CliError {
  // `clerk link` cannot create an instance, so pointing there — as the stale
  // snapshot error does — is a dead end. Only `clerk deploy` creates one.
  return new CliError(
    `Application ${appId} has no ${env} instance yet.\n` +
      "Run `clerk deploy` to create one, then re-run this command.",
    { code: ERROR_CODE.INSTANCE_NOT_FOUND, docsUrl: DOCS_URL },
  );
}

function staleLink(env: InstanceEnv, instanceId: string): CliError {
  return new CliError(
    `This project's link records no ${env} instance, but the application has one (${instanceId}).\n` +
      "Run `clerk link --refresh` to update the link, then re-run this command.",
    { code: ERROR_CODE.INSTANCE_NOT_FOUND, docsUrl: DOCS_URL },
  );
}

/**
 * Second chance for a `resolveInstanceId` miss on a `dev`/`prod` alias.
 *
 * Rethrows anything it isn't equipped to recover — a literal instance ID, a
 * different error — so callers can wrap the happy path in a plain try/catch.
 */
export async function recoverMissingInstance(
  error: unknown,
  profileKey: string,
  profile: Profile,
  flag: string | undefined,
): Promise<{ id: string; label: string }> {
  const env = flag ? instanceAliasEnv(flag) : undefined;
  const recoverable =
    env && error instanceof CliError && error.code === ERROR_CODE.INSTANCE_NOT_FOUND;
  if (!env || !recoverable) throw error;

  // Ask the API before assuming the link is stale: a missing production
  // instance upstream needs `clerk deploy`, not a refresh.
  const app = await fetchLinkedApplication(profile);
  const upstreamId = instanceIdFor(app, env);
  if (!upstreamId) throw missingUpstream(env, profile.appId);

  if (isAgent()) throw staleLink(env, upstreamId);

  log.info(`This project's link records no ${env} instance, but the application has one.`);
  const proceed = await confirm({
    message: `Update the link to use ${env} instance ${upstreamId}?`,
    default: true,
  });
  // Falling back to development would write the wrong credentials into the
  // env file for a command that explicitly asked for production.
  if (!proceed) throw staleLink(env, upstreamId);

  const { profile: refreshed } = await refreshProfileInstances(profileKey, profile, app);
  log.success(`Link updated with ${env} instance ${upstreamId}`);
  return resolveInstanceId(refreshed, flag);
}
