/**
 * Config file management for the Clerk CLI config file.
 * Stores auth identity (per environment) and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CONFIG_FILE } from "./constants.ts";
import { getCurrentEnvName } from "./environment.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";
import { CliError, ERROR_CODE } from "./errors.ts";
import { log } from "./log.ts";

let overrideConfigFile: string | undefined;

/** Test-only: override the config file path. Pass undefined to reset. */
export function _setConfigDir(dir: string | undefined): void {
  overrideConfigFile = dir ? join(dir, "config.json") : undefined;
}

export function getConfigFile(): string {
  return overrideConfigFile ?? CONFIG_FILE;
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

interface ClerkConfig {
  environment?: string;
  auth?: Record<string, Auth>;
  profiles: Record<string, Profile>;
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

  if (raw.auth && typeof raw.auth === "object") {
    const auth = raw.auth as Record<string, unknown>;
    if (typeof auth.userId === "string") {
      // Old format: bare Auth object → assign to production
      config.auth = { production: { userId: auth.userId } };
    } else {
      config.auth = auth as Record<string, Auth>;
    }
  }

  return config;
}

export async function readConfig(): Promise<ClerkConfig> {
  const path = getConfigFile();
  log.debug(`config: reading ${path}`);
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultConfig();
  try {
    const raw = (await file.json()) as Record<string, unknown>;
    return migrateRawConfig(raw);
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config: ClerkConfig): Promise<void> {
  const path = getConfigFile();
  log.debug(`config: writing ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
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

const INSTANCE_ALIASES: Record<string, "development" | "production"> = {
  dev: "development",
  development: "development",
  prod: "production",
  production: "production",
};

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
  cwd?: string;
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
    const { fetchApplication } = await import("./plapi.ts");
    const app = await fetchApplication(options.app);
    const appLabel = app.name || options.app;

    if (options.instance) {
      const env = INSTANCE_ALIASES[options.instance];
      if (env) {
        const matched = app.instances.find((instance) => instance.environment_type === env);
        if (!matched) {
          throw new CliError(`No ${env} instance found for application ${options.app}.`, {
            code: ERROR_CODE.INSTANCE_NOT_FOUND,
          });
        }
        return {
          appId: options.app,
          appLabel,
          instanceId: matched.instance_id,
          instanceLabel: env,
        };
      }

      return {
        appId: options.app,
        appLabel,
        instanceId: options.instance,
        instanceLabel: options.instance,
      };
    }

    const development = app.instances.find(
      (instance) => instance.environment_type === "development",
    );
    if (!development) {
      throw new CliError(`No development instance found for application ${options.app}.`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      });
    }

    return {
      appId: options.app,
      appLabel,
      instanceId: development.instance_id,
      instanceLabel: "development",
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

  const instance = resolveInstanceId(resolved.profile, options.instance);
  return {
    appId: resolved.profile.appId,
    appLabel: resolved.profile.appName || resolved.profile.appId,
    instanceId: instance.id,
    instanceLabel: instance.label,
  };
}

export type { Auth, Profile, ClerkConfig, AppContextOptions };
