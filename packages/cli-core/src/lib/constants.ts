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
// ── File paths ──────────────────────────────────────────────────────────────

const clerkConfigDir = process.env.CLERK_CONFIG_DIR;
const paths = envPaths("clerk-cli", { suffix: "" });

export const CONFIG_FILE = join(clerkConfigDir ?? paths.config, "config.json");
export const CREDENTIALS_FILE = join(clerkConfigDir ?? paths.data, "credentials");

// ── Auth server ─────────────────────────────────────────────────────────────

export const CALLBACK_PATH = "/callback";
export const AUTH_TIMEOUT_MS = Number(process.env.CLERK_AUTH_TIMEOUT_MS) || 2 * 60 * 1000;

// ── OAuth client identification ─────────────────────────────────────────────

/** Signals CLI-originated flow to the dashboard. Must match `CLERK_CLIENT_CLI_VALUE` in clerk/dashboard. */
export const CLERK_CLIENT_CLI = "cli";

// ── OpenAPI Spec ──────────────────────────────────────────────────────────

export const OPENAPI_SPEC_URLS = {
  bapi: "https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2025-11-10.yml",
  platform: "https://raw.githubusercontent.com/clerk/openapi-specs/main/platform/beta.yml",
} as const;

// ── Cache ────────────────────────────────────────────────────────────────

export const CLERK_CACHE_DIR = clerkConfigDir ? join(clerkConfigDir, "cache") : paths.cache;
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Update check ──────────────────────────────────────────────────────────

export const UPDATE_PACKAGE_NAME = "clerk";
export const UPDATE_CACHE_FILE = join(CLERK_CACHE_DIR, "update-check.json");
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
