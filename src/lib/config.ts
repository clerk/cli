/**
 * Config file management for ~/.clerk/config.json.
 * Stores auth identity and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CONFIG_FILE } from "./constants.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";

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

export async function resolveProfile(cwd: string): Promise<{
  path: string;
  profile: Profile;
  resolvedVia: ResolvedVia;
  availableRemote?: string;
} | undefined> {
  const config = await readConfig();

  // Try normalized remote URL first (cross-clone matching)
  const normalizedRemote = await getGitNormalizedRemote();
  if (normalizedRemote && config.profiles[normalizedRemote]) {
    return { path: normalizedRemote, profile: config.profiles[normalizedRemote], resolvedVia: "remote" };
  }

  // For non-remote matches, include availableRemote when a remote URL exists
  const fallbackFields = normalizedRemote ? { availableRemote: normalizedRemote } : {};

  // Try git repo identifier (shared across worktrees, backward compat)
  const repoId = await getGitRepoIdentifier();
  if (repoId && config.profiles[repoId]) {
    return { path: repoId, profile: config.profiles[repoId], resolvedVia: "git-common-dir", ...fallbackFields };
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
    throw new Error(`No ${env} instance configured. Run \`clerk init\` to set one up.`);
  }
  return { id, label: env };
}

export type { Auth, Profile, ClerkConfig };
