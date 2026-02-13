/**
 * Credential store for persisting the OAuth access token.
 * Uses macOS Keychain as primary, falls back to a plaintext file with chmod 600.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";

const SERVICE = "clerk-cli";
const ACCOUNT = "oauth-access-token";

const CREDENTIALS_DIR = join(homedir(), ".clerk");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials");

const isMacOS = process.platform === "darwin";

async function keychainStore(token: string): Promise<boolean> {
  if (!isMacOS) return false;
  try {
    // -U flag updates existing entry if present
    await Bun.$`security add-generic-password -a ${ACCOUNT} -s ${SERVICE} -w ${token} -U`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function keychainGet(): Promise<string | null> {
  if (!isMacOS) return null;
  try {
    const result = await Bun.$`security find-generic-password -a ${ACCOUNT} -s ${SERVICE} -w`.quiet();
    return result.text().trim();
  } catch {
    return null;
  }
}

async function keychainDelete(): Promise<boolean> {
  if (!isMacOS) return false;
  try {
    await Bun.$`security delete-generic-password -a ${ACCOUNT} -s ${SERVICE}`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(token: string): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
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
