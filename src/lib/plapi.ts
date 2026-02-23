/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import { PLAPI_BASE_URL } from "./constants.ts";

export class PlapiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Platform API error (${status}): ${body}`);
    this.name = "PlapiError";
  }
}

function getApiKey(): string {
  // TODO: Support OAuth token from login flow long-term
  const key = process.env.CLERK_PLATFORM_API_KEY;
  if (!key) {
    throw new Error(
      "CLERK_PLATFORM_API_KEY environment variable is required.",
    );
  }
  return key;
}

export async function fetchInstanceConfig(
  applicationId: string,
  instanceId: string,
): Promise<Record<string, unknown>> {
  const url = `${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}/instances/${instanceId}/config`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
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
  secret_key: string;
  publishable_key: string;
}

export interface Application {
  application_id: string;
  instances: ApplicationInstance[];
}

export async function fetchApplication(
  applicationId: string,
): Promise<Application> {
  const url = `${PLAPI_BASE_URL}/v1/platform/applications/${applicationId}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PlapiError(response.status, body);
  }

  return response.json() as Promise<Application>;
}
