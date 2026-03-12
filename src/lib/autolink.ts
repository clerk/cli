import { join } from "node:path";
import { setProfile, type Profile } from "./config.ts";
import { listApplications, type Application, type ApplicationInstance } from "./plapi.ts";
import { getGitRepoIdentifier, getGitNormalizedRemote } from "./git.ts";
import { parseEnvFile } from "./dotenv.ts";
import { detectPublishableKeyName } from "./framework.ts";
import { dim, cyan } from "./color.ts";

const ENV_FILES = [".env.local", ".env"];

interface DetectedKey {
  key: string;
  source: string;
}

export async function findClerkKeys(cwd: string): Promise<DetectedKey[]> {
  const keys: DetectedKey[] = [];
  const seen = new Set<string>();
  const publishableKeyName = await detectPublishableKeyName(cwd);

  function add(key: string, source: string) {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push({ key, source });
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

export async function autolink(
  cwd: string,
): Promise<{ path: string; profile: Profile } | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (detectedKeys.length === 0) return undefined;

  let apps: Application[];
  try {
    apps = await listApplications();
  } catch {
    return undefined;
  }

  if (!Array.isArray(apps)) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) return undefined;

  const normalizedRemote = await getGitNormalizedRemote();
  const repoId = await getGitRepoIdentifier();
  const profileKey = normalizedRemote ?? repoId ?? cwd;

  const devInstance = match.app.instances.find((i) => i.environment_type === "development");
  const prodInstance = match.app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) return undefined;

  const profile: Profile = {
    workspaceId: "",
    appId: match.app.application_id,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  };

  await setProfile(profileKey, profile);

  const label = match.app.name || match.app.application_id;
  console.error(`Auto-linked to ${cyan(label)} ${dim(`(detected key in ${match.source})`)}`);

  return { path: profileKey, profile };
}
