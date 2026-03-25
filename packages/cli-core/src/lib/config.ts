/**
 * Config file management for the Clerk CLI config file.
 * Stores auth identity and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CONFIG_FILE } from "./constants.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";
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
  auth?: Auth;
  profiles: Record<string, Profile>;
}

function defaultConfig(): ClerkConfig {
  return { profiles: {} };
}

export async function readConfig(): Promise<ClerkConfig> {
  const file = Bun.file(configFile());
  if (!(await file.exists())) return defaultConfig();
  try {
    return (await file.json()) as ClerkConfig;
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config: ClerkConfig): Promise<void> {
  await mkdir(dirname(configFile()), { recursive: true });
  await Bun.write(configFile(), JSON.stringify(config, null, 2) + "\n");
}

export async function getAuth(): Promise<Auth | undefined> {
  const config = await readConfig();
  return config.auth;
}

export async function setAuth(auth: Auth): Promise<void> {
  const config = await readConfig();
  config.auth = auth;
  await writeConfig(config);
}

export async function clearAuth(): Promise<void> {
  const config = await readConfig();
  delete config.auth;
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
  const normalizedRemote = await getGitNormalizedRemote();
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
  const repoId = await getGitRepoIdentifier();
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

/**
 * Resolve app context from explicit flags or linked profile.
 * This is the isomorphic resolution chain used by profile-dependent commands:
 *   1. Explicit --app flag (works from any directory)
 *   2. resolveProfile(cwd) (project-aware, existing behavior)
 *   3. Error with helpful message
 */
export async function resolveAppContext(options: {
  app?: string;
  instance?: string;
}): Promise<{ appId: string; appLabel: string; instanceId: string; instanceLabel: string }> {
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
}

export type { Auth, Profile, ClerkConfig };
