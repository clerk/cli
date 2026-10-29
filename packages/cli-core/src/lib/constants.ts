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
export const AUTH_TIMEOUT_MS = Number(process.env.CLERK_AUTH_TIMEOUT_MS) || 15 * 60 * 1000;

// ── OAuth client identification ─────────────────────────────────────────────

/** Signals CLI-originated flow to the dashboard. Must match `CLERK_CLIENT_CLI_VALUE` in clerk/dashboard. */
export const CLERK_CLIENT_CLI = "cli";

// ── First-application bootstrap ─────────────────────────────────────────────

/** Name assigned to the default application created on first CLI login. */
export const DEFAULT_FIRST_APPLICATION_NAME = "My Application";

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

// ── Telemetry ─────────────────────────────────────────────────────────────

/** Event ingestion endpoint (telemetry-service worker → BigQuery). */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://clerk-telemetry.com/v1/event";
export const TELEMETRY_TIMEOUT_MS = 1000;

// ── Feedback (`clerk feedback`) ───────────────────────────────────────────

/**
 * Longer than TELEMETRY_TIMEOUT_MS on purpose: a person who typed a report is
 * waiting for a confirmation, where the per-run event has nobody waiting.
 */
export const FEEDBACK_SEND_TIMEOUT_MS = 5000;
/** Where to send a report when telemetry is off or the send is refused. */
export const GITHUB_ISSUES_URL = "https://github.com/clerk/cli/issues";
/** Recent feedback sends, in the cache directory; best-effort like the update check's file. */
export const FEEDBACK_SENDS_FILE_NAME = "feedback-sends.json";
export const FEEDBACK_DAILY_LIMIT = 50;
export const FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Longest free-text field `clerk feedback` accepts, in characters. The
 * scrubber reads a whole field before it is capped, so the field needs a
 * ceiling; past it the text is refused rather than cut, because a cut before
 * scrubbing could split a secret.
 */
export const FEEDBACK_FIELD_MAX_LENGTH = 1_000_000;
