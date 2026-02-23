/**
 * Config file management for ~/.clerk/config.json.
 * Stores auth identity and path-keyed project profiles.
 */

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CLERK_HOME_DIR, CONFIG_FILE } from "./constants.ts";

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
  instanceId: string;
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

export async function listProfiles(): Promise<Record<string, Profile>> {
  const config = await readConfig();
  return config.profiles;
}

export async function resolveProfile(cwd: string): Promise<{ path: string; profile: Profile } | undefined> {
  const config = await readConfig();
  let dir = cwd;
  while (true) {
    if (config.profiles[dir]) {
      return { path: dir, profile: config.profiles[dir] };
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export type { Auth, Profile, ClerkConfig };
