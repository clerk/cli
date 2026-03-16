/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import { PLAPI_BASE_URL } from "./constants.ts";
import { getToken } from "./credential-store.ts";
import { CliError, PlapiError } from "./errors.ts";

async function getAuthToken(): Promise<string> {
  // Prefer platform API key (OAuth token doesn't have platform scopes yet)
  const key = process.env.CLERK_PLATFORM_API_KEY;
  if (key) return key;

  // Fall back to OAuth access token from `clerk auth login`
  const oauthToken = await getToken();
  if (oauthToken) return oauthToken;

  throw new CliError("Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY.", {
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
    `${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}/instances/${instanceId}/config/schema`,
  );
  if (keys?.length) {
    for (const key of keys) {
      url.searchParams.append("keys", key);
    }
  }
  const response = await fetch(url.toString(), {
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
): Promise<Record<string, unknown>> {
  const token = await getAuthToken();
  const url = `${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}/instances/${instanceId}/config`;
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

export async function fetchApplication(
  applicationId: string,
  includeSecretKeys = false,
): Promise<Application> {
  const token = await getAuthToken();
  const url = new URL(`${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}`);
  if (includeSecretKeys) {
    url.searchParams.set("include_secret_keys", "true");
  }
  const response = await fetch(url.toString(), {
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
): Promise<Record<string, unknown>> {
  const token = await getAuthToken();
  const url = `${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}/instances/${instanceId}/config`;
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
) => sendInstanceConfig("PUT", applicationId, instanceId, config);

export const patchInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
) => sendInstanceConfig("PATCH", applicationId, instanceId, config);

export async function listApplications(): Promise<Application[]> {
  const token = await getAuthToken();
  const url = `${PLAPI_BASE_URL}/v1/platform/applications`;
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
