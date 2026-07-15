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
import { log } from "./log.ts";

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

let currentEnvName: string | undefined;
let profilesSourceLogged = false;

function loadFileProfiles(): Record<string, EnvProfileConfig> | undefined {
  // Try repo root (cwd) first, then fall back to path relative to this source file
  const candidates = [
    join(process.cwd(), ".env-profiles.json"),
    join(import.meta.dir, "..", "..", "..", "..", ".env-profiles.json"),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, "utf-8");
      const profiles = JSON.parse(content) as Record<string, EnvProfileConfig>;
      if (!profilesSourceLogged) {
        profilesSourceLogged = true;
        log.debug(`env: profiles from ${path} (${Object.keys(profiles).join(", ")})`);
      }
      return profiles;
    } catch {
      continue;
    }
  }
  return undefined;
}

function getProfiles(): Record<string, EnvProfileConfig> {
  if (typeof CLI_ENV_PROFILES !== "undefined" && CLI_ENV_PROFILES) {
    if (!profilesSourceLogged) {
      profilesSourceLogged = true;
      log.debug(
        `env: profiles from compile-time CLI_ENV_PROFILES (${Object.keys(CLI_ENV_PROFILES).join(", ")})`,
      );
    }
    return CLI_ENV_PROFILES;
  }
  const fileProfiles = loadFileProfiles();
  if (fileProfiles) {
    return fileProfiles;
  }
  if (!profilesSourceLogged) {
    profilesSourceLogged = true;
    log.debug(
      `env: profiles from defaults — no CLI_ENV_PROFILES and no .env-profiles.json (${Object.keys(DEFAULT_PROFILES).join(", ")})`,
    );
  }
  return DEFAULT_PROFILES;
}

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
  const profile = profiles[name]!;
  const platformApiUrl = process.env.CLERK_PLATFORM_API_URL ?? profile.platformApiUrl;
  log.debug(`env: active environment is "${name}" (platformApiUrl=${platformApiUrl})`);
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
    // Unless scopes are explicitly set, use the default scopes
    scopes: process.env.CLERK_OAUTH_SCOPES ?? "",
    authorizeUrl: new URL("/oauth/authorize", baseUrl).href,
    tokenUrl: new URL("/oauth/token", baseUrl).href,
    userinfoUrl: new URL("/oauth/userinfo", baseUrl).href,
  };
}

export function getPlapiBaseUrl(): string {
  return process.env.CLERK_PLATFORM_API_URL ?? getCurrentEnv().platformApiUrl;
}

/**
 * Returns whether CLERK_PLATFORM_API_URL is set to a URL that differs from the
 * active environment's configured platform URL, along with both URLs so the
 * caller can surface a warning.
 *
 * Comparison normalises both URLs via `new URL().href` so trailing-slash and
 * case differences are ignored; falls back to raw string comparison if either
 * value is not a valid URL.
 */
export function isPlatformApiUrlOverridden():
  | {
      overridden: false;
    }
  | {
      overridden: true;
      overrideUrl: string;
      profileUrl: string;
      envName: string;
    } {
  const override = process.env.CLERK_PLATFORM_API_URL;
  if (!override) return { overridden: false };

  const profileUrl = getCurrentEnv().platformApiUrl;
  const normalize = (u: string) => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };

  if (normalize(override) === normalize(profileUrl)) return { overridden: false };

  return { overridden: true, overrideUrl: override, profileUrl, envName: getCurrentEnvName() };
}

export function getBapiBaseUrl(): string {
  return process.env.CLERK_BACKEND_API_URL ?? getCurrentEnv().backendApiUrl;
}

export function getDashboardUrl(): string {
  return (
    process.env.CLERK_DASHBOARD_URL ?? getCurrentEnv().dashboardUrl ?? "https://dashboard.clerk.com"
  );
}
