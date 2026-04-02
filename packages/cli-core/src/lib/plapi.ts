/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import { getPlapiBaseUrl } from "./environment.ts";
import { getToken } from "./credential-store.ts";
import { CliError, PlapiError, ERROR_CODE } from "./errors.ts";

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
    return key;
  }

  // Fall back to OAuth access token from `clerk auth login`
  const oauthToken = await getToken();
  if (oauthToken) return oauthToken;

  throw new CliError("Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY", {
    code: ERROR_CODE.AUTH_REQUIRED,
    docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
  });
}

export async function fetchInstanceConfigSchema(
  applicationId: string,
  instanceId: string,
  keys?: string[],
): Promise<Record<string, unknown>> {
  const token = await getAuthToken();
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config/schema`,
    getPlapiBaseUrl(),
  );
  if (keys?.length) {
    for (const key of keys) {
      url.searchParams.append("keys", key);
    }
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

export async function fetchInstanceConfig(
  applicationId: string,
  instanceId: string,
  keys?: string[],
): Promise<Record<string, unknown>> {
  const token = await getAuthToken();
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
    getPlapiBaseUrl(),
  );
  if (keys?.length) {
    for (const key of keys) {
      url.searchParams.append("keys", key);
    }
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

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
  const token = await getAuthToken();
  const url = new URL(`/v1/platform/applications/${applicationId}`, getPlapiBaseUrl());
  url.searchParams.set("include_secret_keys", "true");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

  return response.json() as Promise<Application>;
}

async function sendInstanceConfig(
  method: "PUT" | "PATCH",
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean },
): Promise<Record<string, unknown>> {
  const token = await getAuthToken();
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
    getPlapiBaseUrl(),
  );
  if (options?.destructive) {
    url.searchParams.set("destructive", "true");
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

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
  const token = await getAuthToken();
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

  return response.json() as Promise<Application>;
}

export async function listApplications(): Promise<Application[]> {
  const token = await getAuthToken();
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

  return response.json() as Promise<Application[]>;
}
