/**
 * Shared constants for the Clerk CLI.
 * Centralizes configuration values that are used across multiple modules.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ── File paths ──────────────────────────────────────────────────────────────

export const CLERK_HOME_DIR = process.env.CLERK_CONFIG_DIR ?? join(homedir(), ".clerk");
export const CONFIG_FILE = join(CLERK_HOME_DIR, "config.json");
export const CREDENTIALS_FILE = join(CLERK_HOME_DIR, "credentials");

// ── OAuth ───────────────────────────────────────────────────────────────────

const OAUTH_BASE_URL = process.env.CLERK_OAUTH_BASE_URL ?? "https://clerk.clerk.com";

export const OAUTH = {
  clientId: process.env.CLERK_OAUTH_CLIENT_ID ?? "ins_1lyWDZiobr600AKUeQDoSlrEmoM",
  scopes: process.env.CLERK_OAUTH_SCOPES ?? "profile email",
  authorizeUrl: new URL("/oauth/authorize", OAUTH_BASE_URL).href,
  tokenUrl: new URL("/oauth/token", OAUTH_BASE_URL).href,
  userinfoUrl: new URL("/oauth/userinfo", OAUTH_BASE_URL).href,
} as const;

// ── Auth server ─────────────────────────────────────────────────────────────

export const CALLBACK_PATH = "/callback";
export const AUTH_TIMEOUT_MS = Number(process.env.CLERK_AUTH_TIMEOUT_MS) || 2 * 60 * 1000;

// ── Platform API ────────────────────────────────────────────────────────────

export const PLAPI_BASE_URL = process.env.CLERK_PLATFORM_API_URL ?? "https://api.clerk.com";

// ── Keychain ────────────────────────────────────────────────────────────────

export const KEYCHAIN_SERVICE = "clerk-cli";
export const KEYCHAIN_ACCOUNT = "oauth-access-token";
