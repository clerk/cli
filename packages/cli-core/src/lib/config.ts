/**
 * Config file management for the Clerk CLI config file.
 * Stores auth identity (per environment) and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CONFIG_FILE } from "./constants.ts";
import { getCurrentEnvName } from "./environment.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote, getGitRepoRoot } from "./git.ts";
import { CliError, ERROR_CODE, throwUsageError } from "./errors.ts";
import { withHomeFsAccess } from "./host-execution.ts";
import { log } from "./log.ts";
import type { Application, ApplicationInstance } from "./plapi.ts";

let overrideConfigFile: string | undefined;

/** Test-only: override the config file path. Pass undefined to reset. */
export function _setConfigDir(dir: string | undefined): void {
  overrideConfigFile = dir ? join(dir, "config.json") : undefined;
}

export function getConfigFile(): string {
  return (
    overrideConfigFile ??
    (process.env.CLERK_CONFIG_DIR ? join(process.env.CLERK_CONFIG_DIR, "config.json") : CONFIG_FILE)
  );
}

interface Auth {
  userId: string;
}

interface Profile {
  workspaceId: string;
  appId: string;
  appName?: string;
  instances: {
    development: string;
    production?: string;
  };
}

export function profileLabel(profile: Profile): string {
  return profile.appName ? `${profile.appName} (${profile.appId})` : profile.appId;
}

/**
 * Worktree-scoped pointer to the active Clerk instance.
 */
export interface ActiveEntry {
  /**
   * App this pointer belongs to, used to ignore stale cross-app pointers.
   */
  appId: string;
  instanceId: string;
  /**
   * Display label containing the branch name or primary environment.
   */
  label: string;
  environmentType: "development" | "production";
  /**
   * Previous instance ID used by `clerk switch -`.
   */
  previousInstanceId?: string;
  previousLabel?: string;
  /**
   * Git branch recorded for drift detection in `clerk status`.
   */
  gitBranch?: string;
}

/** Persisted Svix relay state for `clerk webhooks listen`. */
interface RelayEntry {
  token: string;
}

interface ClerkConfig {
  environment?: string;
  auth?: Record<string, Auth>;
  profiles: Record<string, Profile>;
  relay?: Record<string, RelayEntry>;
  active?: Record<string, ActiveEntry>;
}

function defaultConfig(): ClerkConfig {
  return { profiles: {} };
}

/**
 * Migrate legacy config format where `auth` was a bare `{ userId }` object
 * into the new per-environment format `{ [envName]: { userId } }`.
 */
function migrateRawConfig(raw: Record<string, unknown>): ClerkConfig {
  const config: ClerkConfig = {
    environment: raw.environment as string | undefined,
    profiles: (raw.profiles as Record<string, Profile>) ?? {},
  };

  if (raw.relay && typeof raw.relay === "object" && !Array.isArray(raw.relay)) {
    const relay: Record<string, RelayEntry> = {};
    for (const [key, val] of Object.entries(raw.relay as Record<string, unknown>)) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof (val as Record<string, unknown>).token === "string"
      ) {
        relay[key] = val as RelayEntry;
      }
    }
    config.relay = relay;
  }

  if (raw.auth && typeof raw.auth === "object") {
    const auth = raw.auth as Record<string, unknown>;
    if (typeof auth.userId === "string") {
      // Old format: bare Auth object → assign to production
      config.auth = { production: { userId: auth.userId } };
    } else {
      config.auth = auth as Record<string, Auth>;
    }
  }

  if (raw.active && typeof raw.active === "object" && !Array.isArray(raw.active)) {
    const active: Record<string, ActiveEntry> = {};
    for (const [key, val] of Object.entries(raw.active as Record<string, unknown>)) {
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        typeof (val as Record<string, unknown>).appId === "string" &&
        typeof (val as Record<string, unknown>).instanceId === "string" &&
        typeof (val as Record<string, unknown>).label === "string" &&
        ((val as Record<string, unknown>).environmentType === "development" ||
          (val as Record<string, unknown>).environmentType === "production")
      ) {
        active[key] = val as ActiveEntry;
      }
    }
    config.active = active;
  }

  return config;
}

export async function readConfig(): Promise<ClerkConfig> {
  const path = getConfigFile();
  log.debug(`config: reading ${path}`);
  return withHomeFsAccess(
    { operation: "read", target: path, label: "CLI config directory" },
    async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) return defaultConfig();
      try {
        const raw = (await file.json()) as Record<string, unknown>;
        return migrateRawConfig(raw);
      } catch {
        return defaultConfig();
      }
    },
  );
}

export async function writeConfig(config: ClerkConfig): Promise<void> {
  const path = getConfigFile();
  log.debug(`config: writing ${path}`);
  await withHomeFsAccess(
    { operation: "write", target: path, label: "CLI config directory" },
    async () => {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
    },
  );
}

export async function getAuth(): Promise<Auth | undefined> {
  const config = await readConfig();
  const envName = getCurrentEnvName();
  return config.auth?.[envName];
}

export async function setAuth(auth: Auth): Promise<void> {
  const config = await readConfig();
  if (!config.auth) config.auth = {};
  config.auth[getCurrentEnvName()] = auth;
  await writeConfig(config);
}

export async function clearAuth(): Promise<void> {
  const config = await readConfig();
  if (config.auth) {
    delete config.auth[getCurrentEnvName()];
    if (Object.keys(config.auth).length === 0) {
      delete config.auth;
    }
  }
  await writeConfig(config);
}

export async function getEnvironment(): Promise<string | undefined> {
  const config = await readConfig();
  return config.environment;
}

export async function setEnvironment(envName: string): Promise<void> {
  const config = await readConfig();
  config.environment = envName;
  await writeConfig(config);
}

export async function getProfile(path: string): Promise<Profile | undefined> {
  const config = await readConfig();
  return config.profiles[path];
}

export async function setProfile(path: string, profile: Profile): Promise<void> {
  const config = await readConfig();
  config.profiles[path] = profile;
  await writeConfig(config);
}

export async function removeProfile(path: string): Promise<void> {
  const config = await readConfig();
  delete config.profiles[path];
  await writeConfig(config);
}

export async function moveProfile(oldKey: string, newKey: string): Promise<void> {
  const config = await readConfig();
  const profile = config.profiles[oldKey];
  if (!profile) return;
  config.profiles[newKey] = profile;
  delete config.profiles[oldKey];
  await writeConfig(config);
}

export async function listProfiles(): Promise<Record<string, Profile>> {
  const config = await readConfig();
  return config.profiles;
}

export async function getRelayEntry(key: string): Promise<RelayEntry | undefined> {
  const config = await readConfig();
  return config.relay?.[key];
}

export async function setRelayEntry(key: string, entry: RelayEntry): Promise<void> {
  const config = await readConfig();
  if (!config.relay) config.relay = {};
  config.relay[key] = entry;
  await writeConfig(config);
}

/**
 * Resolve the storage key for the active-instance pointer: the git worktree
 * root (distinct per worktree) so worktree = feature = active branch. Falls
 * back to cwd outside a git repo.
 */
export async function resolveActiveKey(cwd: string = process.cwd()): Promise<string> {
  return (await getGitRepoRoot(cwd)) ?? cwd;
}

/**
 * Read the active-instance pointer stored under an explicit worktree key.
 */
export async function getActiveInstance(key: string): Promise<ActiveEntry | undefined> {
  const config = await readConfig();
  return config.active?.[key];
}

/**
 * Read the active-instance pointer for `cwd`, but only if it belongs to `appId`.
 * Every consumer must guard against a stale cross-app pointer (e.g. a worktree
 * re-linked to a different app), so this centralizes that check.
 */
export async function getActiveInstanceForApp(
  cwd: string,
  appId: string,
): Promise<ActiveEntry | undefined> {
  const active = await getActiveInstance(await resolveActiveKey(cwd));
  return active && active.appId === appId ? active : undefined;
}

/**
 * Persist an active-instance pointer under an explicit worktree key.
 */
export async function setActiveInstance(key: string, entry: ActiveEntry): Promise<void> {
  const config = await readConfig();
  if (!config.active) config.active = {};
  config.active[key] = entry;
  await writeConfig(config);
}

/**
 * Remove the active-instance pointer stored under an explicit worktree key.
 */
export async function clearActiveInstance(key: string): Promise<void> {
  const config = await readConfig();
  if (config.active) {
    delete config.active[key];
    if (Object.keys(config.active).length === 0) delete config.active;
  }
  await writeConfig(config);
}

type ResolvedVia = "remote" | "git-common-dir" | "directory";

export async function resolveProfile(cwd: string): Promise<
  | {
      path: string;
      profile: Profile;
      resolvedVia: ResolvedVia;
      availableRemote?: string;
    }
  | undefined
> {
  const config = await readConfig();

  // Try normalized remote URL first (cross-clone matching)
  const normalizedRemote = await getGitNormalizedRemote(cwd);
  if (normalizedRemote && config.profiles[normalizedRemote]) {
    return {
      path: normalizedRemote,
      profile: config.profiles[normalizedRemote],
      resolvedVia: "remote",
    };
  }

  // For non-remote matches, include availableRemote when a remote URL exists
  const fallbackFields = normalizedRemote ? { availableRemote: normalizedRemote } : {};

  // Try git repo identifier (shared across worktrees, backward compat)
  const repoId = await getGitRepoIdentifier(cwd);
  if (repoId && config.profiles[repoId]) {
    return {
      path: repoId,
      profile: config.profiles[repoId],
      resolvedVia: "git-common-dir",
      ...fallbackFields,
    };
  }

  // Fall back to directory walking for backward compatibility
  let dir = cwd;
  while (true) {
    const profile = config.profiles[dir];
    if (profile) {
      return { path: dir, profile, resolvedVia: "directory", ...fallbackFields };
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Aliases accepted when selecting a primary development or production instance.
 */
export const INSTANCE_ALIASES: Record<string, "development" | "production"> = {
  dev: "development",
  development: "development",
  prod: "production",
  production: "production",
};

/**
 * Return whether an instance is a primary root rather than a branch.
 */
export function isPrimaryInstance(entry: ApplicationInstance): boolean {
  return !entry.branch_name && !entry.parent_instance_id;
}

export function resolveInstanceId(profile: Profile, flag?: string): { id: string; label: string } {
  if (!flag) {
    return { id: profile.instances.development, label: "development" };
  }

  const env = INSTANCE_ALIASES[flag];
  if (!env) return { id: flag, label: flag }; // literal instance ID

  const id = profile.instances[env];
  if (!id) {
    throw new CliError(`No ${env} instance configured. Run \`clerk link\` to set one up.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }
  return { id, label: env };
}

interface AppContextOptions {
  app?: string;
  instance?: string;
  branch?: string;
  cwd?: string;
}

export function resolveFetchedApplicationInstance(
  appId: string,
  app: Application,
  instance?: string,
  branch?: string,
):
  | { found: true; instance: ApplicationInstance; instanceId: string; instanceLabel: string }
  | { found: false; instanceId: string; instanceLabel: string } {
  if (branch) {
    const matched = app.instances.find((entry) => entry.branch_name === branch);
    if (!matched) {
      throw new CliError(`No branch named "${branch}" found for application ${appId}.`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      });
    }
    return {
      found: true,
      instance: matched,
      instanceId: matched.instance_id,
      instanceLabel: branch,
    };
  }

  if (instance) {
    const env = INSTANCE_ALIASES[instance];
    if (env) {
      const matched = app.instances.find(
        (entry) => entry.environment_type === env && isPrimaryInstance(entry),
      );
      if (!matched) {
        throw new CliError(`No ${env} instance found for application ${appId}.`, {
          code: ERROR_CODE.INSTANCE_NOT_FOUND,
        });
      }
      return {
        found: true,
        instance: matched,
        instanceId: matched.instance_id,
        instanceLabel: env,
      };
    }

    const matched = app.instances.find((entry) => entry.instance_id === instance);
    if (matched) {
      return {
        found: true,
        instance: matched,
        instanceId: matched.instance_id,
        // A branch keeps its branch name as the label so picker/raw-ID selection
        // matches the --branch path. Branches are always development, so this can
        // never become "production" and cannot trip the production guardrails.
        instanceLabel: matched.branch_name || matched.environment_type || instance,
      };
    }

    return {
      found: false,
      instanceId: instance,
      instanceLabel: instance,
    };
  }

  const development = app.instances.find(
    (entry) => entry.environment_type === "development" && isPrimaryInstance(entry),
  );
  if (!development) {
    throw new CliError(`No development instance found for application ${appId}.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  return {
    found: true,
    instance: development,
    instanceId: development.instance_id,
    instanceLabel: "development",
  };
}

/**
 * How resolveAppContext selected the target instance for error attribution.
 */
export type InstanceSource = "flag" | "active-pointer" | "default";

/**
 * Resolve app context from explicit flags or linked profile.
 * This is the isomorphic resolution chain used by profile-dependent commands:
 *   1. Explicit --app flag (works from any directory)
 *   2. resolveProfile(cwd) (project-aware, existing behavior)
 *   3. Error with helpful message
 */
export async function resolveAppContext(options: AppContextOptions): Promise<{
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
  instanceSource: InstanceSource;
}> {
  // --branch and --instance both select an instance, so combining them is
  // ambiguous. Reject up front so the behavior is identical for the --app and
  // linked-profile paths below (which otherwise silently ignore --instance when
  // --branch is set).
  if (options.branch && options.instance) {
    throwUsageError("Cannot combine --branch and --instance. Pass only one to select an instance.");
  }

  if (options.app) {
    const { fetchApplication } = await import("./plapi.ts");
    const app = await fetchApplication(options.app);
    const appLabel = app.name || options.app;
    const resolved = resolveFetchedApplicationInstance(
      options.app,
      app,
      options.instance,
      options.branch,
    );
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
      instanceSource: "flag",
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

  if (options.branch) {
    const { fetchApplication } = await import("./plapi.ts");
    const app = await fetchApplication(resolved.profile.appId);
    const r = resolveFetchedApplicationInstance(
      resolved.profile.appId,
      app,
      undefined,
      options.branch,
    );
    return {
      appId: resolved.profile.appId,
      appLabel: resolved.profile.appName || resolved.profile.appId,
      instanceId: r.instanceId,
      instanceLabel: r.instanceLabel,
      instanceSource: "flag",
    };
  }

  // Persisted active instance: when nothing explicit was passed, honor the
  // pointer `clerk switch` wrote for this worktree. Sits below explicit flags
  // (handled above) and below ambient CLERK_SECRET_KEY (bapi-command short-
  // circuits before reaching here), above the development default below.
  if (!options.instance && !options.branch) {
    const active = await getActiveInstanceForApp(
      options.cwd ?? process.cwd(),
      resolved.profile.appId,
    );
    if (active) {
      return {
        appId: resolved.profile.appId,
        appLabel: resolved.profile.appName || resolved.profile.appId,
        instanceId: active.instanceId,
        instanceLabel: active.label,
        instanceSource: "active-pointer",
      };
    }
  }

  const instance = resolveInstanceId(resolved.profile, options.instance);
  return {
    appId: resolved.profile.appId,
    appLabel: resolved.profile.appName || resolved.profile.appId,
    instanceId: instance.id,
    instanceLabel: instance.label,
    instanceSource: options.instance ? "flag" : "default",
  };
}

export type { Auth, Profile, ClerkConfig, AppContextOptions };
