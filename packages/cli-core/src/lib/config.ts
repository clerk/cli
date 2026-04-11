/**
 * Config file management for the Clerk CLI config file.
 * Stores auth identity (per environment) and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CONFIG_FILE } from "./constants.ts";
import type { Environment } from "./environment.ts";
import type { Plapi } from "./plapi.ts";
import type { Git } from "./git.ts";
import { CliError, ERROR_CODE } from "./errors.ts";

let overrideConfigFile: string | undefined;

/** Test-only: override the config file path. Pass undefined to reset. */
export function _setConfigDir(dir: string | undefined): void {
  overrideConfigFile = dir ? `${dir}/config.json` : undefined;
}

function configFile(): string {
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

type ResolvedProfile =
  | {
      path: string;
      profile: Profile;
      resolvedVia: "remote" | "git-common-dir" | "directory";
      availableRemote?: string;
    }
  | undefined;

export interface ConfigStore {
  readConfig(): Promise<ClerkConfig>;
  writeConfig(config: ClerkConfig): Promise<void>;
  getAuth(): Promise<Auth | undefined>;
  setAuth(auth: Auth): Promise<void>;
  clearAuth(): Promise<void>;
  getEnvironment(): Promise<string | undefined>;
  setEnvironment(envName: string): Promise<void>;
  getProfile(path: string): Promise<Profile | undefined>;
  setProfile(path: string, profile: Profile): Promise<void>;
  removeProfile(path: string): Promise<void>;
  moveProfile(oldKey: string, newKey: string): Promise<void>;
  listProfiles(): Promise<Record<string, Profile>>;
  resolveProfile(cwd: string): Promise<ResolvedProfile>;
  resolveAppContext(options: {
    app?: string;
    instance?: string;
  }): Promise<{ appId: string; appLabel: string; instanceId: string; instanceLabel: string }>;
}

export function createConfig(env: Environment, plapi: Plapi, git: Git): ConfigStore {
  const readConfig = async (): Promise<ClerkConfig> => {
    const file = Bun.file(configFile());
    if (!(await file.exists())) return defaultConfig();
    try {
      const raw = (await file.json()) as Record<string, unknown>;
      return migrateRawConfig(raw);
    } catch {
      return defaultConfig();
    }
  };

  const writeConfig = async (config: ClerkConfig): Promise<void> => {
    await mkdir(dirname(configFile()), { recursive: true });
    await Bun.write(configFile(), JSON.stringify(config, null, 2) + "\n");
  };

  const getAuth = async (): Promise<Auth | undefined> => {
    const config = await readConfig();
    const envName = env.getCurrentEnvName();
    return config.auth?.[envName];
  };

  const setAuth = async (auth: Auth): Promise<void> => {
    const config = await readConfig();
    if (!config.auth) config.auth = {};
    config.auth[env.getCurrentEnvName()] = auth;
    await writeConfig(config);
  };

  const clearAuth = async (): Promise<void> => {
    const config = await readConfig();
    if (config.auth) {
      delete config.auth[env.getCurrentEnvName()];
      if (Object.keys(config.auth).length === 0) {
        delete config.auth;
      }
    }
    await writeConfig(config);
  };

  const getEnvironment = async (): Promise<string | undefined> => {
    const config = await readConfig();
    return config.environment;
  };

  const setEnvironment = async (envName: string): Promise<void> => {
    const config = await readConfig();
    config.environment = envName;
    await writeConfig(config);
  };

  const getProfile = async (path: string): Promise<Profile | undefined> => {
    const config = await readConfig();
    return config.profiles[path];
  };

  const setProfile = async (path: string, profile: Profile): Promise<void> => {
    const config = await readConfig();
    config.profiles[path] = profile;
    await writeConfig(config);
  };

  const removeProfile = async (path: string): Promise<void> => {
    const config = await readConfig();
    delete config.profiles[path];
    await writeConfig(config);
  };

  const moveProfile = async (oldKey: string, newKey: string): Promise<void> => {
    const config = await readConfig();
    const profile = config.profiles[oldKey];
    if (!profile) return;
    config.profiles[newKey] = profile;
    delete config.profiles[oldKey];
    await writeConfig(config);
  };

  const listProfiles = async (): Promise<Record<string, Profile>> => {
    const config = await readConfig();
    return config.profiles;
  };

  const resolveProfile = async (cwd: string): Promise<ResolvedProfile> => {
    const config = await readConfig();

    // Try normalized remote URL first (cross-clone matching)
    const normalizedRemote = await git.getGitNormalizedRemote();
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
    const repoId = await git.getGitRepoIdentifier();
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
  };

  const resolveAppContext = async (options: {
    app?: string;
    instance?: string;
  }): Promise<{ appId: string; appLabel: string; instanceId: string; instanceLabel: string }> => {
    if (options.app) {
      const app = await plapi.fetchApplication(options.app);
      const appLabel = app.name || options.app;

      if (options.instance) {
        const envType = INSTANCE_ALIASES[options.instance];
        if (envType) {
          const matched = app.instances.find((instance) => instance.environment_type === envType);
          if (!matched) {
            throw new CliError(`No ${envType} instance found for application ${options.app}.`, {
              code: ERROR_CODE.INSTANCE_NOT_FOUND,
            });
          }
          return {
            appId: options.app,
            appLabel,
            instanceId: matched.instance_id,
            instanceLabel: envType,
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

    const resolved = await resolveProfile(process.cwd());
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
  };

  return {
    readConfig,
    writeConfig,
    getAuth,
    setAuth,
    clearAuth,
    getEnvironment,
    setEnvironment,
    getProfile,
    setProfile,
    removeProfile,
    moveProfile,
    listProfiles,
    resolveProfile,
    resolveAppContext,
  };
}

export type { Auth, Profile, ClerkConfig };
