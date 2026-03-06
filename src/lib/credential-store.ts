/**
 * Credential store for persisting the OAuth access token.
 * Uses macOS Keychain as primary, falls back to a plaintext file with chmod 600.
 */

import { dirname } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { CREDENTIALS_FILE, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "./constants.ts";

const isMacOS = process.platform === "darwin";

async function keychainStore(token: string): Promise<boolean> {
  if (!isMacOS) return false;
  try {
    // -U flag updates existing entry if present
    await Bun.$`security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w ${token} -U`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function keychainGet(): Promise<string | null> {
  if (!isMacOS) return null;
  try {
    const result =
      await Bun.$`security find-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w`.quiet();
    return result.text().trim();
  } catch {
    return null;
  }
}

async function keychainDelete(): Promise<boolean> {
  if (!isMacOS) return false;
  try {
    await Bun.$`security delete-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(token: string): Promise<void> {
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
  await Bun.write(CREDENTIALS_FILE, token);
  await chmod(CREDENTIALS_FILE, 0o600);
}

async function fileGet(): Promise<string | null> {
  const file = Bun.file(CREDENTIALS_FILE);
  if (!(await file.exists())) return null;
  const content = await file.text();
  return content.trim() || null;
}

async function fileDelete(): Promise<void> {
  const file = Bun.file(CREDENTIALS_FILE);
  if (await file.exists()) {
    await Bun.write(CREDENTIALS_FILE, "");
  }
}

export async function storeToken(token: string): Promise<void> {
  const stored = await keychainStore(token);
  if (!stored) {
    await fileStore(token);
  }
}

export async function getToken(): Promise<string | null> {
  const token = await keychainGet();
  if (token) return token;
  return fileGet();
}

export async function deleteToken(): Promise<void> {
  await keychainDelete();
  await fileDelete();
}
