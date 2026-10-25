import { setProfile, type Profile } from "./config.ts";
import { listApplications, type Application, type ApplicationInstance } from "./plapi.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";
import { errorMessage } from "./errors.ts";
import {
  couldntTellReason,
  readFolderKeys,
  SDK_KEYLESS_SOURCE,
  unreadableFolderReason,
  type FolderKeys,
  type FolderRead,
  type LocatedKey,
} from "./local-keys.ts";
import { dim, cyan } from "./color.ts";
import { log } from "./log.ts";

interface DetectedKey {
  key: string;
  source: string;
}

export type { FolderRead };

/** The publishable key `clerk link` matches the folder by, or why there isn't one. */
export type LinkKey =
  | { status: "found"; key: LocatedKey }
  | { status: "none" }
  | { status: "couldnt_tell"; reason: string };

/**
 * The one publishable key `clerk link` matches the folder by: the one its app
 * loads, in the framework's load order (`readFolderKeys`). Never a list of
 * fallbacks: matching a key the app doesn't load would link an app the folder
 * doesn't run on.
 *
 * "Couldn't tell" when a Clerk key line can't be read (the app may load it),
 * when the files disagree with no documented order to pick one, or when an
 * env file can't be read. The SDK keyless file's key isn't used here: an
 * SDK-only folder has its own step in `clerk link`. `reason` reads as a
 * clause, for a message to build on.
 */
export async function findLinkKey(cwd: string, read?: FolderRead): Promise<LinkKey> {
  if (read && "readError" in read) return { status: "couldnt_tell", reason: read.readError };
  let keys: FolderKeys;
  try {
    keys = read ?? (await readFolderKeys(cwd));
  } catch (error) {
    return { status: "couldnt_tell", reason: unreadableFolderReason(error) };
  }
  const reason = couldntTellReason(keys);
  if (reason) return { status: "couldnt_tell", reason };
  const key = keys.publishableKey;
  if (!key || key.source === SDK_KEYLESS_SOURCE) return { status: "none" };
  return { status: "found", key };
}

/**
 * Returns the first key/app pair where a detected key matches an app instance's publishable key.
 * Keys are tried in order, so earlier entries in `keys` have higher priority.
 */
export function matchKeyToApp(
  keys: DetectedKey[],
  apps: Application[],
): { app: Application; instance: ApplicationInstance; source: string } | undefined {
  const byKey = new Map<string, { app: Application; instance: ApplicationInstance }>();
  for (const app of apps) {
    for (const instance of app.instances) {
      byKey.set(instance.publishable_key, { app, instance });
    }
  }

  for (const { key, source } of keys) {
    const match = byKey.get(key);
    if (match) return { ...match, source };
  }
  return undefined;
}

/** Returns undefined when the app has no development instance. */
export async function linkApp(
  app: Application,
  cwd: string,
): Promise<{ path: string; profile: Profile } | undefined> {
  const devInstance = app.instances.find((i) => i.environment_type === "development");
  if (!devInstance) return undefined;

  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  const normalizedRemote = await getGitNormalizedRemote(cwd);
  const repoId = await getGitRepoIdentifier(cwd);
  const profileKey = normalizedRemote ?? repoId ?? cwd;

  const profile: Profile = {
    workspaceId: "",
    appId: app.application_id,
    appName: app.name,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  };

  await setProfile(profileKey, profile);
  return { path: profileKey, profile };
}

/** What auto-linking did, or why it didn't link. */
export type AutolinkResult =
  | { status: "linked"; path: string; profile: Profile }
  | { status: "no_key" }
  | { status: "couldnt_tell"; reason: string }
  | { status: "list_failed"; error: unknown }
  | { status: "no_match"; source: string }
  | { status: "no_development_instance"; appId: string };

/**
 * Links the folder to the account's app whose publishable key is the one the
 * folder's app loads (`findLinkKey`). Never throws for a failed app list: it
 * reports `list_failed` with the error, so each caller decides what that means.
 *
 * `beforeLink` runs on the matched app before the link is saved, and may throw
 * to stop the link with nothing saved. `read` is the caller's read of the
 * folder's keys; without it, the folder is read here.
 */
export async function autolink(
  cwd: string,
  options: { beforeLink?: (app: Application) => Promise<void>; read?: FolderRead } = {},
): Promise<AutolinkResult> {
  const found = await findLinkKey(cwd, options.read);
  if (found.status === "none") {
    log.debug("autolink: no clerk publishable key found in env or .env files");
    return { status: "no_key" };
  }
  if (found.status === "couldnt_tell") {
    log.debug(`autolink: couldn't tell which key the app loads: ${found.reason}`);
    return { status: "couldnt_tell", reason: found.reason };
  }
  const { key } = found;
  log.debug(`autolink: matching the key from ${key.source}`);

  let apps: Application[];
  try {
    apps = await listApplications();
  } catch (error) {
    log.debug(`autolink: listApplications failed — ${errorMessage(error)}`);
    return { status: "list_failed", error };
  }

  if (!Array.isArray(apps)) {
    return { status: "list_failed", error: new Error("the application list wasn't a list") };
  }

  const match = matchKeyToApp([{ key: key.value, source: key.source }], apps);
  if (!match) {
    log.debug(`autolink: no app matched the key (checked ${apps.length} app(s))`);
    return { status: "no_match", source: key.source };
  }
  log.debug(
    `autolink: matched key from ${match.source} → app ${match.app.application_id} (${match.app.name ?? "unnamed"})`,
  );

  await options.beforeLink?.(match.app);
  const result = await linkApp(match.app, cwd);
  if (!result) return { status: "no_development_instance", appId: match.app.application_id };

  const label = match.app.name || match.app.application_id;
  log.info(`Auto-linked to ${cyan(label)} ${dim(`(detected key in ${match.source})`)}`);

  return { status: "linked", ...result };
}
