/**
 * Environment profile management for the Clerk CLI.
 *
 * Supports switching between Clerk infrastructure environments (e.g. production, staging).
 * Environment profiles are injected at build time via CLI_ENV_PROFILES and contain
 * the OAuth client ID, OAuth base URL, Platform API URL, and Backend API URL for each env.
 *
 * During local development (when CLI_ENV_PROFILES is not defined), profiles are loaded
 * from .env-profiles.json at the repo root, falling back to hardcoded defaults.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EnvProfileConfig {
  oauthClientId: string;
  oauthBaseUrl: string;
  platformApiUrl: string;
  backendApiUrl: string;
  dashboardUrl?: string;
}

const DEFAULT_PROFILES: Record<string, EnvProfileConfig> = {
  production: {
    oauthClientId: "ins_1lyWDZiobr600AKUeQDoSlrEmoM",
    oauthBaseUrl: "https://clerk.clerk.com",
    platformApiUrl: "https://api.clerk.com",
    backendApiUrl: "https://api.clerk.dev",
    dashboardUrl: "https://dashboard.clerk.com",
  },
};

function loadFileProfiles(): Record<string, EnvProfileConfig> | undefined {
  // Try repo root (cwd) first, then fall back to path relative to this source file
  const candidates = [
    join(process.cwd(), ".env-profiles.json"),
    join(import.meta.dir, "..", "..", "..", "..", ".env-profiles.json"),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content);
    } catch {
      continue;
    }
  }
  return undefined;
}

function getProfiles(): Record<string, EnvProfileConfig> {
  if (typeof CLI_ENV_PROFILES !== "undefined" && CLI_ENV_PROFILES) {
    return CLI_ENV_PROFILES;
  }
  return loadFileProfiles() ?? DEFAULT_PROFILES;
}

let currentEnvName: string | undefined;

/**
 * Set the active environment. Called during CLI initialization from config,
 * or by the switch-env command.
 */
export function setCurrentEnv(name: string): void {
  const profiles = getProfiles();
  if (!profiles[name]) {
    const available = Object.keys(profiles).join(", ");
    throw new Error(`Unknown environment "${name}". Available environments: ${available}`);
  }
  currentEnvName = name;
}

/** Get the name of the active environment. Defaults to "production". */
export function getCurrentEnvName(): string {
  return currentEnvName ?? "production";
}

/** Get the profile config for the active environment. */
export function getCurrentEnv(): EnvProfileConfig {
  const name = getCurrentEnvName();
  const profiles = getProfiles();
  return profiles[name] ?? profiles.production!;
}

/** List all available environment names. */
export function getAvailableEnvs(): string[] {
  return Object.keys(getProfiles());
}

/** Check if an environment name is valid. */
export function isValidEnv(name: string): boolean {
  return name in getProfiles();
}

// ── Derived config from the active environment profile ──────────────────────

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

export function getPlapiBaseUrl(): string {
  return process.env.CLERK_PLATFORM_API_URL ?? getCurrentEnv().platformApiUrl;
}

export function getBapiBaseUrl(): string {
  return process.env.CLERK_BACKEND_API_URL ?? getCurrentEnv().backendApiUrl;
}

export function getDashboardUrl(): string {
  return (
    process.env.CLERK_DASHBOARD_URL ?? getCurrentEnv().dashboardUrl ?? "https://dashboard.clerk.com"
  );
}
