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
import type { Environment } from "./environment.ts";

export const KEYCHAIN_SERVICE = "clerk-cli";
export const KEYCHAIN_ACCOUNT = "oauth-access-token";

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

export interface CredentialStore {
  getToken(): Promise<string | null>;
  storeToken(token: string): Promise<void>;
  deleteToken(): Promise<void>;
}

export function createCredentialStore(env: Environment): CredentialStore {
  const keychainAccount = (): string => {
    const envName = env.getCurrentEnvName();
    if (envName === "production") return KEYCHAIN_ACCOUNT;
    return `${KEYCHAIN_ACCOUNT}:${envName}`;
  };

  const credentialsFile = (): string => {
    const envName = env.getCurrentEnvName();
    if (envName === "production") return CREDENTIALS_FILE;
    return `${CREDENTIALS_FILE}.${envName}`;
  };

  const keyringStore = async (token: string): Promise<boolean> => {
    const mod = await getKeyring();
    if (!mod) return false;
    try {
      const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
      entry.setPassword(token);
      return true;
    } catch {
      return false;
    }
  };

  const keyringGet = async (): Promise<string | null> => {
    const mod = await getKeyring();
    if (!mod) return null;
    try {
      const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
      return entry.getPassword();
    } catch {
      return null;
    }
  };

  const keyringDelete = async (): Promise<boolean> => {
    const mod = await getKeyring();
    if (!mod) return false;
    try {
      const entry = new mod.Entry(KEYCHAIN_SERVICE, keychainAccount());
      entry.deletePassword();
      return true;
    } catch {
      return false;
    }
  };

  const fileStore = async (token: string): Promise<void> => {
    const file = credentialsFile();
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, token);
    await chmod(file, 0o600);
  };

  const fileGet = async (): Promise<string | null> => {
    const file = Bun.file(credentialsFile());
    if (!(await file.exists())) return null;
    const content = await file.text();
    return content.trim() || null;
  };

  const fileDelete = async (): Promise<void> => {
    try {
      await unlink(credentialsFile());
    } catch {
      // File doesn't exist, nothing to delete
    }
  };

  return {
    async storeToken(token: string): Promise<void> {
      const stored = await keyringStore(token);
      if (stored) {
        // Clean up any stale plaintext credentials from a previous file-based storage
        await fileDelete();
        return;
      }
      await fileStore(token);
    },
    async getToken(): Promise<string | null> {
      const token = await keyringGet();
      if (token) return token;
      return fileGet();
    },
    async deleteToken(): Promise<void> {
      await keyringDelete();
      await fileDelete();
    },
  };
}
