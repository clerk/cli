/**
 * Resolving which application and instance a command should target.
 *
 * This sits one layer above `config.ts`: config is the storage layer
 * (profiles on disk, sync resolution against a stored snapshot), while this
 * module may hit the API — fetching an explicit `--app`, or recovering a
 * stale link via `link-refresh.ts`. Keeping it separate keeps the import
 * graph acyclic: `link-refresh.ts` imports `config.ts`, and this module
 * imports both.
 */

import {
  resolveFetchedApplicationInstance,
  resolveInstanceId,
  resolveProfile,
  type Profile,
} from "./config.ts";
import { CliError, ERROR_CODE } from "./errors.ts";
import { recoverMissingInstance } from "./link-refresh.ts";
import { fetchApplication } from "./plapi.ts";

export interface AppContextOptions {
  app?: string;
  instance?: string;
  cwd?: string;
}

/**
 * `resolveInstanceId` against a stored profile, with one recovery attempt when
 * the profile predates the instance being asked for.
 */
async function resolveLinkedInstance(
  profileKey: string,
  profile: Profile,
  instance: string | undefined,
): Promise<{ id: string; label: string }> {
  try {
    return resolveInstanceId(profile, instance);
  } catch (error) {
    return recoverMissingInstance(error, profileKey, profile, instance);
  }
}

/**
 * Resolve app context from explicit flags or linked profile.
 * This is the isomorphic resolution chain used by profile-dependent commands:
 *   1. Explicit --app flag (works from any directory)
 *   2. resolveProfile(cwd) (project-aware, existing behavior)
 *   3. Error with helpful message
 */
export async function resolveAppContext(
  options: AppContextOptions,
): Promise<{ appId: string; appLabel: string; instanceId: string; instanceLabel: string }> {
  if (options.app) {
    const app = await fetchApplication(options.app);
    const appLabel = app.name || options.app;
    const resolved = resolveFetchedApplicationInstance(options.app, app, options.instance);
    if (!resolved.found) {
      throw new CliError(
        `Instance ${resolved.instanceId} not found in application ${options.app}.`,
        { code: ERROR_CODE.INSTANCE_NOT_FOUND },
      );
    }

    return {
      appId: options.app,
      appLabel,
      instanceId: resolved.instanceId,
      instanceLabel: resolved.instanceLabel,
    };
  }

  const resolved = await resolveProfile(options.cwd ?? process.cwd());
  if (!resolved) {
    throw new CliError(
      "No Clerk project linked to this directory.\n" +
        "Either:\n" +
        "  - Run `clerk link` from your project directory\n" +
        "  - Pass --app <app_id> to target an app directly",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const instance = await resolveLinkedInstance(resolved.path, resolved.profile, options.instance);
  return {
    appId: resolved.profile.appId,
    appLabel: resolved.profile.appName || resolved.profile.appId,
    instanceId: instance.id,
    instanceLabel: instance.label,
  };
}
