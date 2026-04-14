/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import type { Environment } from "./environment.ts";
import type { CredentialStore } from "./credential-store.ts";
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

export interface Plapi {
  validateKeyPrefix(key: string, expected: "ak_" | "sk_"): void;
  getAuthToken(): Promise<string>;
  fetchInstanceConfigSchema(
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<Record<string, unknown>>;
  fetchInstanceConfig(
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<Record<string, unknown>>;
  fetchApplication(applicationId: string): Promise<Application>;
  createApplication(name: string): Promise<Application>;
  putInstanceConfig(
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ): Promise<Record<string, unknown>>;
  patchInstanceConfig(
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ): Promise<Record<string, unknown>>;
  listApplications(): Promise<Application[]>;
}

export function createPlapi(env: Environment, credentialStore: CredentialStore): Plapi {
  const getAuthToken = async (): Promise<string> => {
    // Prefer platform API key (OAuth token doesn't have platform scopes yet)
    const key = env.getPlatformApiKey();
    if (key) {
      validateKeyPrefix(key, "ak_");
      return key;
    }

    // Fall back to OAuth access token from `clerk auth login`
    const oauthToken = await credentialStore.getToken();
    if (oauthToken) return oauthToken;

    throw new CliError("Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY", {
      code: ERROR_CODE.AUTH_REQUIRED,
      docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
    });
  };

  const fetchInstanceConfigSchema = async (
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<Record<string, unknown>> => {
    const token = await getAuthToken();
    const url = new URL(
      `/v1/platform/applications/${applicationId}/instances/${instanceId}/config/schema`,
      env.getPlapiBaseUrl(),
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
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Record<string, unknown>>;
  };

  const fetchInstanceConfig = async (
    applicationId: string,
    instanceId: string,
    keys?: string[],
  ): Promise<Record<string, unknown>> => {
    const token = await getAuthToken();
    const url = new URL(
      `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
      env.getPlapiBaseUrl(),
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
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Record<string, unknown>>;
  };

  const fetchApplication = async (applicationId: string): Promise<Application> => {
    const token = await getAuthToken();
    const url = new URL(`/v1/platform/applications/${applicationId}`, env.getPlapiBaseUrl());
    url.searchParams.set("include_secret_keys", "true");
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Application>;
  };

  const sendInstanceConfig = async (
    method: "PUT" | "PATCH",
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ): Promise<Record<string, unknown>> => {
    const token = await getAuthToken();
    const url = new URL(
      `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
      env.getPlapiBaseUrl(),
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
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Record<string, unknown>>;
  };

  const putInstanceConfig = (
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ) => sendInstanceConfig("PUT", applicationId, instanceId, config, options);

  const patchInstanceConfig = (
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ) => sendInstanceConfig("PATCH", applicationId, instanceId, config, options);

  const createApplication = async (name: string): Promise<Application> => {
    const token = await getAuthToken();
    const url = new URL("/v1/platform/applications", env.getPlapiBaseUrl());
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
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Application>;
  };

  const listApplications = async (): Promise<Application[]> => {
    const token = await getAuthToken();
    const url = new URL("/v1/platform/applications", env.getPlapiBaseUrl());
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PlapiError(response.status, body, url.toString());
    }

    return response.json() as Promise<Application[]>;
  };

  return {
    validateKeyPrefix,
    getAuthToken,
    fetchInstanceConfigSchema,
    fetchInstanceConfig,
    fetchApplication,
    createApplication,
    putInstanceConfig,
    patchInstanceConfig,
    listApplications,
  };
}
