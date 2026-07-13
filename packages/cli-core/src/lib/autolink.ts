import { join } from "node:path";
import { isPrimaryInstance, setProfile, type Profile } from "./config.ts";
import { listApplications, type Application, type ApplicationInstance } from "./plapi.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";
import { parseEnvFile } from "./dotenv.ts";
import { detectPublishableKeyName } from "./framework.ts";
import { dim, cyan } from "./color.ts";
import { log } from "./log.ts";

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

/** Returns undefined when the app has no development instance. */
export async function linkApp(
  app: Application,
  cwd: string,
): Promise<{ path: string; profile: Profile } | undefined> {
  // The development root is the null-parent instance; forks are also
  // `development`, so scope by parent to avoid linking to a branch (ADR-0010).
  const devInstance = app.instances.find(
    (i) => i.environment_type === "development" && isPrimaryInstance(i),
  );
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

export async function autolink(
  cwd: string,
): Promise<{ path: string; profile: Profile } | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (detectedKeys.length === 0) {
    log.debug("autolink: no clerk publishable keys found in env or .env files");
    return undefined;
  }
  log.debug(
    `autolink: found ${detectedKeys.length} key(s) (sources: ${detectedKeys.map((k) => k.source).join(", ")})`,
  );

  let apps: Application[];
  try {
    apps = await listApplications();
  } catch (err) {
    // Autolink is a best-effort fallback — swallow the failure at debug level
    // so callers can gracefully proceed to the interactive picker.
    log.debug(`autolink: listApplications failed — ${err}`);
    return undefined;
  }

  if (!Array.isArray(apps)) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) {
    log.debug(`autolink: no app matched any detected key (checked ${apps.length} app(s))`);
    return undefined;
  }
  log.debug(
    `autolink: matched key from ${match.source} → app ${match.app.application_id} (${match.app.name ?? "unnamed"})`,
  );

  const result = await linkApp(match.app, cwd);
  if (!result) return undefined;

  const label = match.app.name || match.app.application_id;
  log.info(`Auto-linked to ${cyan(label)} ${dim(`(detected key in ${match.source})`)}`);

  return result;
}
