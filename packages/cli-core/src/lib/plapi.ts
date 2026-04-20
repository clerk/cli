/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import { getPlapiBaseUrl, getCurrentEnvName } from "./environment.ts";
import { getToken } from "./credential-store.ts";
import { CliError, PlapiError, ERROR_CODE } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";

/**
 * Validate that a key has the expected prefix and suggest the correct key type
 * if the user mixed them up.
 */
export function validateKeyPrefix(key: string, expected: "ak_" | "sk_"): void {
  if (key.startsWith(expected)) return;

  const wrongPrefix = expected === "ak_" ? "sk_" : "ak_";
  const expectedLabel = expected === "ak_" ? "Platform API key (ak_...)" : "Secret key (sk_...)";
  const wrongLabel = expected === "ak_" ? "secret key (sk_...)" : "Platform API key (ak_...)";

  if (key.startsWith(wrongPrefix)) {
    throw new CliError(
      `Expected a ${expectedLabel}, but received a ${wrongLabel}.\n` +
        "Get the correct key from: https://dashboard.clerk.com/last-active?path=api-keys",
      { code: ERROR_CODE.INVALID_KEY_FORMAT },
    );
  }
}

export async function getAuthToken(): Promise<string> {
  // Prefer platform API key (OAuth token doesn't have platform scopes yet)
  const key = process.env.CLERK_PLATFORM_API_KEY;
  if (key) {
    validateKeyPrefix(key, "ak_");
    log.debug(
      `plapi: using CLERK_PLATFORM_API_KEY for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
    );
    return key;
  }

  // Fall back to OAuth access token from `clerk auth login`
  const oauthToken = await getToken();
  if (oauthToken) {
    log.debug(
      `plapi: using OAuth token from credential store for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
    );
    return oauthToken;
  }

  throw new CliError("Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY", {
    code: ERROR_CODE.AUTH_REQUIRED,
    docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
  });
}

/**
 * Local wrapper that adds the standard Bearer auth + Accept headers and
 * throws PlapiError on non-ok responses. Debug logging is centralized in
 * `loggedFetch` — don't add inline `log.debug` calls here or in callers.
 */
async function plapiFetch(method: string, url: URL, init?: { body?: string }): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  const response = await loggedFetch(url, {
    tag: "plapi",
    method,
    headers,
    body: init?.body,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body, url.toString());
  }
  return response;
}

/** Normalize and append `keys` query params, splitting comma-separated values. */
function appendKeys(url: URL, keys?: string[]): void {
  if (!keys?.length) return;
  for (const key of keys) {
    for (const k of key.split(",")) {
      const trimmed = k.trim();
      if (trimmed) url.searchParams.append("keys", trimmed);
    }
  }
}

export async function fetchInstanceConfigSchema(
  applicationId: string,
  instanceId: string,
  keys?: string[],
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config/schema`,
    getPlapiBaseUrl(),
  );
  appendKeys(url, keys);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function fetchInstanceConfig(
  applicationId: string,
  instanceId: string,
  keys?: string[],
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
    getPlapiBaseUrl(),
  );
  appendKeys(url, keys);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Record<string, unknown>>;
}

export interface ApplicationInstance {
  instance_id: string;
  environment_type: string;
  secret_key?: string;
  publishable_key: string;
}

export interface Application {
  application_id: string;
  name?: string;
  instances: ApplicationInstance[];
}

export async function fetchApplication(applicationId: string): Promise<Application> {
  const url = new URL(`/v1/platform/applications/${applicationId}`, getPlapiBaseUrl());
  url.searchParams.set("include_secret_keys", "true");
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Application>;
}

async function sendInstanceConfig(
  method: "PUT" | "PATCH",
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean },
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
    getPlapiBaseUrl(),
  );
  if (options?.destructive) {
    url.searchParams.set("destructive", "true");
  }
  const response = await plapiFetch(method, url, { body: JSON.stringify(config) });
  return response.json() as Promise<Record<string, unknown>>;
}

export const putInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean },
) => sendInstanceConfig("PUT", applicationId, instanceId, config, options);

export const patchInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean },
) => sendInstanceConfig("PATCH", applicationId, instanceId, config, options);

export async function createApplication(name: string): Promise<Application> {
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await plapiFetch("POST", url, { body: JSON.stringify({ name }) });
  return response.json() as Promise<Application>;
}

export async function listApplications(): Promise<Application[]> {
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Application[]>;
}
