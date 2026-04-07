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
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
    entry.setPassword(token);
    return true;
  } catch {
    return false;
  }
}

async function keyringGet(): Promise<string | null> {
  const mod = await getKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
    return entry.getPassword();
  } catch {
    return null;
  }
}

async function keyringDelete(): Promise<boolean> {
  const mod = await getKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(token: string): Promise<void> {
  const file = credentialsFile();
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, token);
  await chmod(file, 0o600);
}

async function fileGet(): Promise<string | null> {
  const file = Bun.file(credentialsFile());
  if (!(await file.exists())) return null;
  const content = await file.text();
  return content.trim() || null;
}

async function fileDelete(): Promise<void> {
  try {
    await unlink(credentialsFile());
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

export interface CredentialStore {
  getToken(): Promise<string | null>;
  storeToken(token: string): Promise<void>;
  deleteToken(): Promise<void>;
}

export const credentialStore: CredentialStore = {
  getToken,
  storeToken,
  deleteToken,
};
