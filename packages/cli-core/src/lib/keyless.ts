import { join } from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { getBapiBaseUrl } from "./environment.ts";
import { detectPublishableKeyName, detectSecretKeyName, detectEnvFile } from "./framework.ts";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "./dotenv.ts";
import { BapiError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";

const BREADCRUMB_DIR = ".clerk";
const BREADCRUMB_FILE = "keyless.json";
const CREATE_TIMEOUT_MS = 15_000;

interface AccountlessAppResponse {
  publishable_key: string;
  secret_key: string;
  claim_url: string;
}

interface KeylessBreadcrumb {
  claimToken: string;
  createdAt: string;
}

function isKeylessBreadcrumb(value: unknown): value is KeylessBreadcrumb {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as KeylessBreadcrumb).claimToken === "string" &&
    typeof (value as KeylessBreadcrumb).createdAt === "string"
  );
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await loggedFetch(url, {
      tag: "bapi",
      method: "POST",
      headers,
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new BapiError(response.status, text, response.headers);
  }

  return response.json() as Promise<AccountlessAppResponse>;
}

export async function writeKeysToEnvFile(
  cwd: string,
  keys: { publishableKey: string; secretKey: string },
): Promise<void> {
  const [publishableKeyName, secretKeyName, envFile] = await Promise.all([
    detectPublishableKeyName(cwd),
    detectSecretKeyName(cwd),
    detectEnvFile(cwd),
  ]);

  const targetFile = join(cwd, envFile);
  const existingContent = await Bun.file(targetFile)
    .text()
    .catch(() => "");

  const merged = mergeEnvVars(parseEnvFile(existingContent), {
    [publishableKeyName]: keys.publishableKey,
    [secretKeyName]: keys.secretKey,
  });

  await Bun.write(targetFile, serializeEnvFile(merged));
  log.info(`Environment variables written to ${envFile}`);
}

export function parseClaimToken(claimUrl: string): string {
  // WHATWG URL rejects bare relative paths without a base; use example.invalid (RFC 6761)
  const base = claimUrl.startsWith("http") ? undefined : "https://example.invalid";
  const token = new URL(claimUrl, base).searchParams.get("token");
  if (!token) throw new Error(`No token parameter in claim URL: ${claimUrl}`);
  return token;
}

function breadcrumbPath(cwd: string): string {
  return join(cwd, BREADCRUMB_DIR, BREADCRUMB_FILE);
}

async function ensureGitignoreEntry(cwd: string, entry: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const content = await Bun.file(gitignorePath)
    .text()
    .catch(() => "");
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return;
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await Bun.write(gitignorePath, `${content}${separator}${entry}\n`);
  log.debug(`Added ${entry} to .gitignore`);
}

export async function writeKeylessBreadcrumb(cwd: string, claimToken: string): Promise<void> {
  await ensureGitignoreEntry(cwd, BREADCRUMB_DIR + "/");
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
    const data: unknown = await Bun.file(breadcrumbPath(cwd)).json();
    if (isKeylessBreadcrumb(data)) return data;
    log.warn("Keyless breadcrumb file has wrong shape; clearing it to allow fresh setup.");
    await clearKeylessBreadcrumb(cwd);
    return undefined;
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
