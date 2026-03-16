/**
 * Shared constants for the Clerk CLI.
 * Centralizes configuration values that are used across multiple modules.
 */

import { join } from "node:path";
import envPaths from "env-paths";

// ── File paths ──────────────────────────────────────────────────────────────

const clerkConfigDir = process.env.CLERK_CONFIG_DIR;
const paths = envPaths("clerk-cli", { suffix: false });

export const CONFIG_FILE = join(clerkConfigDir ?? paths.config, "config.json");
export const CREDENTIALS_FILE = join(clerkConfigDir ?? paths.data, "credentials");

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

// ── Backend API ────────────────────────────────────────────────────────────

export const BAPI_BASE_URL = process.env.CLERK_BACKEND_API_URL ?? "https://api.clerk.dev";

// ── OpenAPI Spec ──────────────────────────────────────────────────────────

export const OPENAPI_SPECS_BASE_URL = "https://raw.githubusercontent.com/clerk/openapi-specs/main";

export interface OpenApiSpecInfo {
  /** Directory name in the clerk/openapi-specs repo */
  repoDir: string;
  latest: string;
  versions: string[];
}

export const OPENAPI_SPECS: Record<string, OpenApiSpecInfo> = {
  backend: {
    repoDir: "bapi",
    latest: "2025-11-10",
    versions: ["2021-02-05", "2024-10-01", "2025-03-12", "2025-04-10", "2025-11-10"],
  },
  frontend: {
    repoDir: "fapi",
    latest: "2025-11-10",
    versions: ["2021-02-05", "2024-10-01", "2025-03-12", "2025-04-10", "2025-11-10"],
  },
  platform: {
    repoDir: "platform",
    latest: "beta",
    versions: ["beta"],
  },
  webhooks: {
    repoDir: "webhooks",
    latest: "2025-04-15",
    versions: ["2025-04-15"],
  },
};

/** Short aliases for internal API names */
export const OPENAPI_SPEC_ALIASES: Record<string, string> = {
  bapi: "backend",
  fapi: "frontend",
};

/** Kept for backward compat with catalog.ts */
export const OPENAPI_SPEC_URLS = {
  bapi: `${OPENAPI_SPECS_BASE_URL}/bapi/2025-11-10.yml`,
  platform: `${OPENAPI_SPECS_BASE_URL}/platform/beta.yml`,
} as const;

// ── Cache ────────────────────────────────────────────────────────────────

export const CLERK_CACHE_DIR = clerkConfigDir ? join(clerkConfigDir, "cache") : paths.cache;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
