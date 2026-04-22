/**
 * Credential store for persisting the OAuth access token.
 * Uses platform keyring as primary (via @napi-rs/keyring), falls back to a plaintext file with chmod 600.
 *
 * Tokens are stored per-environment so switching environments preserves auth state.
 * Keychain account: "oauth-access-token:<envName>"
 * File fallback: "credentials.<envName>"
 */

import { dirname } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { CREDENTIALS_FILE } from "./constants.ts";
import { getCurrentEnvName } from "./environment.ts";
import { log } from "./log.ts";
import { resolveCliVersion } from "./version.ts";

export const KEYCHAIN_SERVICE = "clerk-cli";
export const LOCAL_DEV_KEYCHAIN_SERVICE = "clerk-cli-dev";
export const KEYCHAIN_ACCOUNT = "oauth-access-token";
const RELEASE_MACOS_TEAM_ID = "L8SD6SB282";
const RELEASE_MACOS_IDENTIFIER = "clerk";

function keychainAccount(): string {
  const envName = getCurrentEnvName();
  if (envName === "production") return KEYCHAIN_ACCOUNT;
  return `${KEYCHAIN_ACCOUNT}:${envName}`;
}

function credentialsFile(): string {
  const envName = getCurrentEnvName();
  if (envName === "production") return CREDENTIALS_FILE;
  return `${CREDENTIALS_FILE}.${envName}`;
}

let keyringModule: typeof import("@napi-rs/keyring") | null | undefined;
let keychainServicePromise: Promise<string> | undefined;

async function getKeyring(): Promise<typeof import("@napi-rs/keyring") | null> {
  if (keyringModule !== undefined) return keyringModule;
  try {
    keyringModule = await import("@napi-rs/keyring");
    return keyringModule;
  } catch {
    keyringModule = null;
    return null;
  }
}

export function isReleaseSignedMacosBinary(
  cliVersion: string | undefined,
  codesignOutput: string,
): boolean {
  if (!cliVersion) return false;
  return (
    codesignOutput.includes(`TeamIdentifier=${RELEASE_MACOS_TEAM_ID}`) &&
    codesignOutput.includes(`Identifier=${RELEASE_MACOS_IDENTIFIER}`)
  );
}

async function resolveKeychainService(): Promise<string> {
  if (process.platform !== "darwin") return KEYCHAIN_SERVICE;
  if (keychainServicePromise) return keychainServicePromise;

  keychainServicePromise = (async () => {
    const cliVersion = resolveCliVersion();
    if (!cliVersion) {
      log.debug(
        `credentials: using local macOS keychain namespace (service=${LOCAL_DEV_KEYCHAIN_SERVICE}, reason=unversioned-cli)`,
      );
      return LOCAL_DEV_KEYCHAIN_SERVICE;
    }

    const proc = Bun.spawnSync(["codesign", "-dvvv", process.execPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const codesignOutput = `${proc.stdout.toString()}${proc.stderr.toString()}`;

    if (proc.exitCode === 0 && isReleaseSignedMacosBinary(cliVersion, codesignOutput)) {
      return KEYCHAIN_SERVICE;
    }

    log.debug(
      `credentials: using local macOS keychain namespace (service=${LOCAL_DEV_KEYCHAIN_SERVICE}, execPath=${process.execPath})`,
    );
    return LOCAL_DEV_KEYCHAIN_SERVICE;
  })();

  return keychainServicePromise;
}

async function keyringStore(token: string): Promise<boolean> {
  const mod = await getKeyring();
  if (!mod) return false;
  const service = await resolveKeychainService();
  const account = keychainAccount();
  log.debug(`credentials: storing token in keyring (service=${service}, account=${account})`);
  try {
    const entry = new mod.Entry(service, account);
    entry.setPassword(token);
    return true;
  } catch {
    log.debug("credentials: failed to store token in keyring");
    return false;
  }
}

async function keyringGet(): Promise<string | null> {
  const mod = await getKeyring();
  if (!mod) {
    log.debug("credentials: keyring not available");
    return null;
  }
  const service = await resolveKeychainService();
  const account = keychainAccount();
  log.debug(`credentials: checking keyring (service=${service}, account=${account})`);
  try {
    const entry = new mod.Entry(service, account);
    const token = entry.getPassword();
    log.debug(`credentials: ${token ? "found token in keyring" : "no token in keyring"}`);
    return token;
  } catch {
    log.debug("credentials: keyring lookup failed");
    return null;
  }
}

async function keyringDelete(): Promise<boolean> {
  const mod = await getKeyring();
  if (!mod) return false;
  const service = await resolveKeychainService();
  const account = keychainAccount();
  log.debug(`credentials: deleting token from keyring (service=${service}, account=${account})`);
  try {
    const entry = new mod.Entry(service, account);
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(token: string): Promise<void> {
  const path = credentialsFile();
  log.debug(`credentials: storing token in file ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, token, { mode: 0o600 });
}

async function fileGet(): Promise<string | null> {
  const path = credentialsFile();
  log.debug(`credentials: checking file ${path}`);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    log.debug("credentials: credentials file not found");
    return null;
  }
  const content = await file.text();
  const token = content.trim() || null;
  log.debug(`credentials: ${token ? "found token in file" : "credentials file is empty"}`);
  return token;
}

async function fileDelete(): Promise<void> {
  const path = credentialsFile();
  try {
    log.debug(`credentials: deleting credentials file ${path}`);
    await unlink(path);
  } catch {
    // File doesn't exist, nothing to delete
  }
}

export async function storeToken(token: string): Promise<void> {
  const stored = await keyringStore(token);
  if (stored) {
    // Clean up any stale plaintext credentials from a previous file-based storage
    await fileDelete();
    return;
  }

  await fileStore(token);
}

let tokenOverride: string | null | undefined;

/** Test-only: override getToken() result. Pass undefined to clear. */
export function _setTokenOverride(value: string | null | undefined): void {
  tokenOverride = value;
}

export async function getToken(): Promise<string | null> {
  if (tokenOverride !== undefined) return tokenOverride;

  const token = await keyringGet();
  if (token) return token;

  return fileGet();
}

export async function deleteToken(): Promise<void> {
  await keyringDelete();
  await fileDelete();
}
