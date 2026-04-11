import { join } from "node:path";
import type { Need } from "./deps.ts";
import type { Profile } from "./config.ts";
import type { Application, ApplicationInstance } from "./plapi.ts";
import { parseEnvFile } from "./dotenv.ts";
import { detectPublishableKeyName } from "./framework.ts";
import { dim, cyan } from "./color.ts";

const ENV_FILES = [".env", ".env.local"];

interface DetectedKey {
  key: string;
  source: string;
}

/**
 * Collects Clerk publishable keys from the environment and .env files.
 * Sources are checked in order: process.env, .env, .env.local (last wins for duplicates).
 */
export async function findClerkKeys(cwd: string): Promise<DetectedKey[]> {
  const keys: DetectedKey[] = [];
  const publishableKeyName = await detectPublishableKeyName(cwd);

  function add(key: string, source: string) {
    if (!key) return;
    const existing = keys.findIndex((k) => k.key === key);
    if (existing !== -1) {
      keys[existing]!.source = source;
    } else {
      keys.push({ key, source });
    }
  }

  if (process.env[publishableKeyName]) {
    add(process.env[publishableKeyName]!, `${publishableKeyName} env var`);
  }

  for (const envFile of ENV_FILES) {
    const filePath = join(cwd, envFile);
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;

    const content = await file.text();
    const lines = parseEnvFile(content);
    for (const line of lines) {
      if (line.type !== "entry") continue;
      if (line.key === publishableKeyName) {
        add(line.value, envFile);
      }
    }
  }

  return keys;
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

export type AutolinkDeps = Need<{
  plapi: "listApplications";
  configStore: "setProfile";
  git: "getGitRepoIdentifier" | "getGitNormalizedRemote";
  log: "info" | "error";
}>;

export async function autolink(
  deps: AutolinkDeps,
  cwd: string,
): Promise<{ path: string; profile: Profile } | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (detectedKeys.length === 0) return undefined;

  let apps: Application[];
  try {
    apps = await deps.plapi.listApplications();
  } catch (err) {
    deps.log.error(`Failed to list applications: ${err}`);
    return undefined;
  }

  if (!Array.isArray(apps)) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) return undefined;

  const normalizedRemote = await deps.git.getGitNormalizedRemote();
  const repoId = await deps.git.getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;

  const devInstance = match.app.instances.find((i) => i.environment_type === "development");
  const prodInstance = match.app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) return undefined;

  const instances: Profile["instances"] = {
    development: devInstance.instance_id,
  };
  if (prodInstance) {
    instances.production = prodInstance.instance_id;
  }

  const profile: Profile = {
    workspaceId: "",
    appId: match.app.application_id,
    appName: match.app.name,
    instances,
  };

  await deps.configStore.setProfile(profileKey, profile);

  const label = match.app.name || match.app.application_id;
  deps.log.info(`Auto-linked to ${cyan(label)} ${dim(`(detected key in ${match.source})`)}`);

  return { path: profileKey, profile };
}
