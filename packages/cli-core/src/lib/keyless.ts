import { join } from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { getBapiBaseUrl } from "./environment.ts";
import { detectPublishableKeyName, detectSecretKeyName } from "./framework.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "./dotenv.ts";
import { log } from "./log.ts";

const ENV_LOCAL = ".env.local";
const BREADCRUMB_DIR = ".clerk";
const BREADCRUMB_FILE = "keyless.json";

interface AccountlessAppResponse {
  publishable_key: string;
  secret_key: string;
  claim_url: string;
}

interface KeylessBreadcrumb {
  claimToken: string;
  createdAt: string;
}

/** Creates an accountless Clerk application via the public BAPI endpoint. */
export async function createAccountlessApp(framework?: string): Promise<AccountlessAppResponse> {
  const url = new URL("/v1/accountless_applications", getBapiBaseUrl());

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    ...(framework && { "Clerk-Framework": framework }),
  };

  const body = new URLSearchParams({ source: "cli" });
  const response = await fetch(url, { method: "POST", headers, body: body.toString() });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create accountless application (${response.status}): ${text}`);
  }

  return response.json() as Promise<AccountlessAppResponse>;
}

export async function writeKeysToEnvFile(
  cwd: string,
  keys: { publishableKey: string; secretKey: string },
): Promise<void> {
  const [publishableKeyName, secretKeyName] = await Promise.all([
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
  ]);

  const targetFile = join(cwd, ENV_LOCAL);
  const existingContent = await Bun.file(targetFile)
    .text()
    .catch(() => "");

  const merged = mergeEnvVars(parseEnvFile(existingContent), {
    [publishableKeyName]: keys.publishableKey,
    [secretKeyName]: keys.secretKey,
  });

  await Bun.write(targetFile, serializeEnvFile(merged));
  log.info(`Environment variables written to ${ENV_LOCAL}`);
}

export function parseClaimToken(claimUrl: string): string {
  const base = claimUrl.startsWith("http") ? undefined : "https://placeholder.com";
  const token = new URL(claimUrl, base).searchParams.get("token");
  if (!token) throw new Error(`No token parameter in claim URL: ${claimUrl}`);
  return token;
}

function breadcrumbPath(cwd: string): string {
  return join(cwd, BREADCRUMB_DIR, BREADCRUMB_FILE);
}

export async function writeKeylessBreadcrumb(cwd: string, claimToken: string): Promise<void> {
  await mkdir(join(cwd, BREADCRUMB_DIR), { recursive: true });

  const breadcrumb: KeylessBreadcrumb = {
    claimToken,
    createdAt: new Date().toISOString(),
  };

  await Bun.write(breadcrumbPath(cwd), JSON.stringify(breadcrumb, null, 2) + "\n");
  log.debug(`Wrote keyless breadcrumb to ${BREADCRUMB_DIR}/${BREADCRUMB_FILE}`);
}

export async function readKeylessBreadcrumb(cwd: string): Promise<KeylessBreadcrumb | undefined> {
  try {
    return (await Bun.file(breadcrumbPath(cwd)).json()) as KeylessBreadcrumb;
  } catch {
    return undefined;
  }
}

export async function clearKeylessBreadcrumb(cwd: string): Promise<void> {
  try {
    await unlink(breadcrumbPath(cwd));
    log.debug("Cleared keyless breadcrumb");
  } catch {
    // idempotent
  }
}
