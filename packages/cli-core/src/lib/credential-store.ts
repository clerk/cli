/**
 * Credential store for persisting the OAuth access token.
 * Uses platform keyring as primary (via @napi-rs/keyring), falls back to a plaintext file with chmod 600.
 *
 * Tokens are stored per-environment so switching environments preserves auth state.
 * Keychain account: "oauth-access-token:<envName>"
 * File fallback: "credentials.<envName>"
 */

import { dirname } from "node:path";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { CREDENTIALS_FILE } from "./constants.ts";
import { getCurrentEnvName } from "./environment.ts";
import { log } from "./log.ts";

export const KEYCHAIN_SERVICE = "clerk-cli";
export const KEYCHAIN_ACCOUNT = "oauth-access-token";

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

async function keyringStore(token: string): Promise<boolean> {
  const mod = await getKeyring();
  if (!mod) return false;
  const account = keychainAccount();
  log.debug(
    `credentials: storing token in keyring (service=${KEYCHAIN_SERVICE}, account=${account})`,
  );
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, account);
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
  const account = keychainAccount();
  log.debug(`credentials: checking keyring (service=${KEYCHAIN_SERVICE}, account=${account})`);
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, account);
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
  const account = keychainAccount();
  log.debug(
    `credentials: deleting token from keyring (service=${KEYCHAIN_SERVICE}, account=${account})`,
  );
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, account);
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(token: string): Promise<void> {
  const path = credentialsFile();
  log.debug(`credentials: storing token in file ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, token);
  await chmod(path, 0o600);
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
