/**
 * Credential store for persisting the OAuth session.
 * Uses platform keyring as primary (via @napi-rs/keyring), falls back to a plaintext file with chmod 600.
 *
 * Sessions are stored per-environment so switching environments preserves auth state.
 * Keychain account: "oauth-access-token:<envName>"
 * File fallback: "credentials.<envName>"
 */

import { dirname } from "node:path";
import { mkdir, chmod, writeFile, unlink } from "node:fs/promises";
import { CREDENTIALS_FILE } from "./constants.ts";
import { getCurrentEnvName } from "./environment.ts";
import { ApiError, AuthError, CliError, ERROR_CODE } from "./errors.ts";
import { log } from "./log.ts";
import { refreshAccessToken, type TokenResponse } from "./token-exchange.ts";
import { resolveCliVersion } from "./version.ts";

export const KEYCHAIN_SERVICE = "clerk-cli";
export const LOCAL_DEV_KEYCHAIN_SERVICE = "clerk-cli-dev";
export const KEYCHAIN_ACCOUNT = "oauth-access-token";
const RELEASE_MACOS_TEAM_ID = "L8SD6SB282";
const RELEASE_MACOS_IDENTIFIER = "clerk";
const JWT_EXPIRY_LEEWAY_MS = 30_000;

export interface OAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
}

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

async function keyringStore(value: string): Promise<boolean> {
  const mod = await getKeyring();
  if (!mod) return false;
  const service = await resolveKeychainService();
  const account = keychainAccount();
  log.debug(`credentials: storing session in keyring (service=${service}, account=${account})`);
  try {
    const entry = new mod.Entry(service, account);
    entry.setPassword(value);
    return true;
  } catch {
    log.debug("credentials: failed to store session in keyring");
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
    const value = entry.getPassword();
    log.debug(`credentials: ${value ? "found session in keyring" : "no session in keyring"}`);
    return value;
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
  log.debug(`credentials: deleting session from keyring (service=${service}, account=${account})`);
  try {
    const entry = new mod.Entry(service, account);
    entry.deletePassword();
    return true;
  } catch {
    return false;
  }
}

async function fileStore(value: string): Promise<void> {
  const path = credentialsFile();
  log.debug(`credentials: storing session in file ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
  // We keep the chmod because if the file permission had changed
  // `writeFile` wouldn't set it back to 0o600
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
  const value = (await file.text()).trim() || null;
  log.debug(`credentials: ${value ? "found session in file" : "credentials file is empty"}`);
  return value;
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

function isOAuthSession(value: unknown): value is OAuthSession {
  if (!value || typeof value !== "object") return false;

  const session = value as Record<string, unknown>;
  return (
    typeof session.accessToken === "string" &&
    typeof session.refreshToken === "string" &&
    typeof session.expiresAt === "number" &&
    typeof session.tokenType === "string"
  );
}

function parseStoredSession(raw: string): OAuthSession | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isOAuthSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function encodeStoredValue(value: string | OAuthSession): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function getJwtExpiryMs(token: string): number | null {
  const [, payload] = token.split(".");
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpiredJwt(token: string): boolean {
  const expiresAt = getJwtExpiryMs(token);
  if (expiresAt === null) return true;
  return expiresAt <= Date.now() + JWT_EXPIRY_LEEWAY_MS;
}

function isExpiredSession(session: OAuthSession): boolean {
  if (Number.isFinite(session.expiresAt)) {
    return session.expiresAt <= Date.now() + JWT_EXPIRY_LEEWAY_MS;
  }
  return isExpiredJwt(session.accessToken);
}

function sessionExpiredError(): AuthError {
  return new AuthError({ reason: "session_expired" });
}

function isInvalidGrant(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 401) &&
    /\binvalid_grant\b/i.test(error.body)
  );
}

async function readStoredValue(): Promise<string | null> {
  if (tokenOverride !== undefined) return tokenOverride;

  const value = await keyringGet();
  if (value) return value;

  return fileGet();
}

async function refreshStoredSession(session: OAuthSession): Promise<string> {
  let tokenResponse: TokenResponse;
  try {
    tokenResponse = await refreshAccessToken(session.refreshToken);
  } catch (error) {
    if (isInvalidGrant(error)) {
      await deleteToken();
      throw sessionExpiredError();
    }
    throw error;
  }

  const nextSession = createOAuthSession(tokenResponse, session.refreshToken);
  await storeToken(nextSession);
  return nextSession.accessToken;
}

export function createOAuthSession(
  tokenResponse: TokenResponse,
  currentRefreshToken?: string,
): OAuthSession {
  const refreshToken = tokenResponse.refresh_token ?? currentRefreshToken;
  if (!refreshToken) {
    throw new CliError(
      "Authentication response did not include a refresh token. Run `clerk auth login` to re-authenticate",
      {
        code: ERROR_CODE.AUTH_REQUIRED,
      },
    );
  }

  return {
    accessToken: tokenResponse.access_token,
    refreshToken,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    tokenType: tokenResponse.token_type,
  };
}

export async function storeToken(value: string | OAuthSession): Promise<void> {
  const encoded = encodeStoredValue(value);
  const stored = await keyringStore(encoded);
  if (stored) {
    // Clean up any stale plaintext credentials from a previous file-based storage
    await fileDelete();
    return;
  }

  await fileStore(encoded);
}

let tokenOverride: string | null | undefined;

/** Test-only: override getToken() result. Pass undefined to clear. */
export function _setTokenOverride(value: string | null | undefined): void {
  tokenOverride = value;
}

export async function getToken(): Promise<string | null> {
  const value = await readStoredValue();
  if (!value) return null;
  return parseStoredSession(value)?.accessToken ?? value;
}

export async function getStoredSession(): Promise<OAuthSession | null> {
  const value = await readStoredValue();
  if (!value) return null;
  return parseStoredSession(value);
}

export async function hasStoredCredentials(): Promise<boolean> {
  return (await readStoredValue()) !== null;
}

export async function getValidToken(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) {
    if (await hasStoredCredentials()) {
      throw sessionExpiredError();
    }
    return null;
  }

  if (!isExpiredSession(session)) {
    return session.accessToken;
  }

  return refreshStoredSession(session);
}

export async function deleteToken(): Promise<void> {
  await keyringDelete();
  await fileDelete();
}
