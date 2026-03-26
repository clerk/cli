/**
 * Shared constants for the Clerk CLI.
 * Centralizes configuration values that are used across multiple modules.
 *
 * Environment-dependent values (OAuth, API URLs) are resolved via functions
 * so they reflect the active environment set by `clerk switch-env`.
 * Process env vars always take highest priority for per-value overrides.
 */

import { join } from "node:path";
import envPaths from "env-paths";
import { getCurrentEnv } from "./environment.ts";

// ── File paths ──────────────────────────────────────────────────────────────

const clerkConfigDir = process.env.CLERK_CONFIG_DIR;
const paths = envPaths("clerk-cli", { suffix: false });

export const CONFIG_FILE = join(clerkConfigDir ?? paths.config, "config.json");
export const CREDENTIALS_FILE = join(clerkConfigDir ?? paths.data, "credentials");

// ── OAuth ───────────────────────────────────────────────────────────────────

export function getOAuthConfig() {
  const env = getCurrentEnv();
  const baseUrl = process.env.CLERK_OAUTH_BASE_URL ?? env.oauthBaseUrl;
  return {
    clientId: process.env.CLERK_OAUTH_CLIENT_ID ?? env.oauthClientId,
    scopes: process.env.CLERK_OAUTH_SCOPES ?? "profile email",
    authorizeUrl: new URL("/oauth/authorize", baseUrl).href,
    tokenUrl: new URL("/oauth/token", baseUrl).href,
    userinfoUrl: new URL("/oauth/userinfo", baseUrl).href,
  };
}

// ── Auth server ─────────────────────────────────────────────────────────────

export const CALLBACK_PATH = "/callback";
export const AUTH_TIMEOUT_MS = Number(process.env.CLERK_AUTH_TIMEOUT_MS) || 2 * 60 * 1000;

// ── Platform API ────────────────────────────────────────────────────────────

export function getPlapiBaseUrl(): string {
  return process.env.CLERK_PLATFORM_API_URL ?? getCurrentEnv().platformApiUrl;
}

// ── Backend API ────────────────────────────────────────────────────────────

export function getBapiBaseUrl(): string {
  return process.env.CLERK_BACKEND_API_URL ?? getCurrentEnv().backendApiUrl;
}

// ── OpenAPI Spec ──────────────────────────────────────────────────────────

export const OPENAPI_SPEC_URLS = {
  bapi: "https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2025-11-10.yml",
  platform: "https://raw.githubusercontent.com/clerk/openapi-specs/main/platform/beta.yml",
} as const;

// ── Cache ────────────────────────────────────────────────────────────────

export const CLERK_CACHE_DIR = clerkConfigDir ? join(clerkConfigDir, "cache") : paths.cache;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
