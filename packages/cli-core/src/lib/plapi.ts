/**
 * Platform API (PLAPI) client.
 * Thin HTTP wrapper for Clerk's Platform API endpoints.
 */

import { getPlapiBaseUrl, getCurrentEnvName } from "./environment.ts";
import { getValidToken } from "./credential-store.ts";
import { AuthError, CliError, ERROR_CODE, PlapiError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";

/**
 * Canonical attribution marker written to `applications.from_source` when the
 * CLI creates an application through PLAPI. Surfaces in BigQuery via
 * `dim_applications.from_source` for growth analytics. Do not change without
 * coordinating with the growth-data team - the value is consumed by dbt
 * models and dashboards downstream.
 */
const CLI_FROM_SOURCE = "cli";

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
  const key = process.env.CLERK_PLATFORM_API_KEY;
  if (key) {
    validateKeyPrefix(key, "ak_");
    log.debug(
      `plapi: using CLERK_PLATFORM_API_KEY for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
    );
    return key;
  }

  // Fall back to OAuth access token from `clerk auth login`
  const oauthToken = await getValidToken();
  if (oauthToken) {
    log.debug(
      `plapi: using OAuth token from credential store for auth (env=${getCurrentEnvName()}, target=${getPlapiBaseUrl()})`,
    );
    return oauthToken;
  }

  throw new AuthError({
    reason: "not_logged_in",
    message: "Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY",
    docsUrl: "https://clerk.com/docs/guides/development/clerk-environment-variables",
  });
}

/**
 * Local wrapper that adds the standard Bearer auth + Accept headers and
 * throws PlapiError on non-ok responses. Debug logging is centralized in
 * `loggedFetch`; don't add inline `log.debug` calls here or in callers.
 */
type PlapiFetchInit = {
  body?: string;
  idempotencyKey?: string;
  /** Config version used for optimistic concurrency control. */
  ifMatch?: string;
};

async function plapiFetch(method: string, url: URL, init?: PlapiFetchInit): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  if (init?.ifMatch) headers["If-Match"] = init.ifMatch;
  const response = await loggedFetch(url, {
    tag: "plapi",
    method,
    headers,
    body: init?.body,
  });
  if (!response.ok) {
    throw await PlapiError.fromResponse(response);
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

export type ConfigSchemaProperty = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  readOnly?: boolean;
  properties?: Record<string, ConfigSchemaProperty>;
  required?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  "x-clerk-sensitive"?: boolean;
};

export type InstanceConfigSchema = {
  $schema?: string;
  $id?: string;
  type?: string;
  properties?: Record<string, ConfigSchemaProperty>;
};

export async function fetchInstanceConfigSchema(
  applicationId: string,
  instanceId: string,
  keys?: string[],
): Promise<InstanceConfigSchema> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config/schema`,
    getPlapiBaseUrl(),
  );
  appendKeys(url, keys);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<InstanceConfigSchema>;
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

function unexpectedApplicationResponse(): CliError {
  return new CliError("Clerk returned an invalid application response.", {
    code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
  });
}

function validateApplication(value: unknown): Application {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedApplicationResponse();
  }

  const application = value as Record<string, unknown>;
  if (
    typeof application.application_id !== "string" ||
    (application.name !== undefined && typeof application.name !== "string") ||
    !Array.isArray(application.instances)
  ) {
    throw unexpectedApplicationResponse();
  }

  for (const value of application.instances) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw unexpectedApplicationResponse();
    }
    const instance = value as Record<string, unknown>;
    if (
      typeof instance.instance_id !== "string" ||
      typeof instance.environment_type !== "string" ||
      typeof instance.publishable_key !== "string" ||
      (instance.secret_key !== undefined && typeof instance.secret_key !== "string")
    ) {
      throw unexpectedApplicationResponse();
    }
  }

  return value as Application;
}

async function readApplicationResponse(response: Response): Promise<Application> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw unexpectedApplicationResponse();
  }
  return validateApplication(value);
}

export type DomainSummary = {
  id: string;
  name: string;
};

export type CnameTarget = {
  host: string;
  value: string;
  required: boolean;
};

export type ApplicationDomain = {
  object: "domain";
  id: string;
  name: string;
  is_satellite: boolean;
  is_provider_domain: boolean;
  frontend_api_url: string;
  accounts_portal_url?: string;
  proxy_url?: string;
  development_origin: string;
  cname_targets?: CnameTarget[];
  created_at: string;
  updated_at: string;
};

export type ListApplicationDomainsResponse = {
  data: ApplicationDomain[];
  total_count: number;
};

export type ProductionInstanceResponse = {
  id: string;
  object: "instance";
  environment_type: "production";
  active_domain: ApplicationDomain | null;
  secret_key?: string;
  publishable_key: string;
  created_at: number;
  updated_at: number;
};

export type CreateProductionInstanceParams = {
  domain: string;
  environment_type: "production";
  clone_instance_id?: string;
};

export type DeployStatus = "complete" | "incomplete";

type DomainCheckStatus = {
  status: string;
  required?: boolean;
};

export type DomainStatusResponse = {
  status: DeployStatus;
  dns?: DomainCheckStatus;
  ssl?: DomainCheckStatus;
  mail?: DomainCheckStatus;
  proxy?: DomainCheckStatus;
};

export type TriggerDNSCheckResponse = DomainStatusResponse & {
  domain_id: string;
  last_run_at: number | null;
};

export type NativeSettings = {
  object: "native_settings";
  api_enabled: boolean;
};

function unexpectedNativeSettingsResponse(): CliError {
  return new CliError("Clerk returned an invalid Native API settings response.", {
    code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
  });
}

/**
 * Validate Native settings at runtime. This is exported so callers that inject
 * an API implementation in tests or integrations retain the same fail-closed
 * behavior as the production HTTP client.
 */
export function validateNativeSettings(value: unknown): NativeSettings {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).object !== "native_settings" ||
    typeof (value as Record<string, unknown>).api_enabled !== "boolean"
  ) {
    throw unexpectedNativeSettingsResponse();
  }
  return value as NativeSettings;
}

async function readNativeSettingsResponse(response: Response): Promise<NativeSettings> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw unexpectedNativeSettingsResponse();
  }
  return validateNativeSettings(value);
}

export type IOSApplication = {
  object: "ios_application";
  id: string;
  app_id_prefix: string;
  bundle_id: string;
  created_at: number;
  updated_at: number;
};

function unexpectedIOSApplicationResponse(): CliError {
  return new CliError("Clerk returned an invalid iOS application response.", {
    code: ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
  });
}

export function validateIOSApplication(value: unknown): IOSApplication {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedIOSApplicationResponse();
  }
  const item = value as Record<string, unknown>;
  if (
    item.object !== "ios_application" ||
    typeof item.id !== "string" ||
    typeof item.app_id_prefix !== "string" ||
    typeof item.bundle_id !== "string" ||
    typeof item.created_at !== "number" ||
    !Number.isFinite(item.created_at) ||
    typeof item.updated_at !== "number" ||
    !Number.isFinite(item.updated_at)
  ) {
    throw unexpectedIOSApplicationResponse();
  }
  return value as IOSApplication;
}

export function validateIOSApplications(value: unknown): IOSApplication[] {
  if (!Array.isArray(value)) throw unexpectedIOSApplicationResponse();
  return value.map(validateIOSApplication);
}

async function readIOSApplicationResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw unexpectedIOSApplicationResponse();
  }
}

export type CreateIOSApplicationParams = {
  appIdPrefix: string;
  bundleId: string;
};

export type IdempotentMutationOptions = {
  /** Reuse this value when retrying the same mutation. */
  idempotencyKey: string;
};

export async function getNativeSettings(
  applicationId: string,
  envOrInstanceId: string,
): Promise<NativeSettings> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${envOrInstanceId}/native_settings`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("GET", url);
  return readNativeSettingsResponse(response);
}

export async function enableNativeApi(
  applicationId: string,
  envOrInstanceId: string,
  options?: IdempotentMutationOptions,
): Promise<NativeSettings> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${envOrInstanceId}/native_settings`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("PATCH", url, {
    body: JSON.stringify({ api_enabled: true }),
    idempotencyKey: options?.idempotencyKey,
  });
  return readNativeSettingsResponse(response);
}

export async function listIOSApplications(
  applicationId: string,
  envOrInstanceId: string,
): Promise<IOSApplication[]> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${envOrInstanceId}/native_applications/ios`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("GET", url);
  return validateIOSApplications(await readIOSApplicationResponse(response));
}

export async function createIOSApplication(
  applicationId: string,
  envOrInstanceId: string,
  params: CreateIOSApplicationParams,
  options: IdempotentMutationOptions,
): Promise<IOSApplication> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${envOrInstanceId}/native_applications/ios`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("POST", url, {
    body: JSON.stringify({
      app_id_prefix: params.appIdPrefix,
      bundle_id: params.bundleId,
    }),
    idempotencyKey: options.idempotencyKey,
  });
  return validateIOSApplication(await readIOSApplicationResponse(response));
}

export interface FetchApplicationOptions {
  /**
   * Include instance secret keys in the response. This defaults to true for
   * backwards compatibility; callers that only need publishable metadata
   * should opt out so secret keys never enter their process.
   */
  includeSecretKeys?: boolean;
}

export async function fetchApplication(
  applicationId: string,
  options: FetchApplicationOptions = {},
): Promise<Application> {
  const url = new URL(`/v1/platform/applications/${applicationId}`, getPlapiBaseUrl());
  if (options.includeSecretKeys !== false) {
    url.searchParams.set("include_secret_keys", "true");
  }
  const response = await plapiFetch("GET", url);
  return readApplicationResponse(response);
}

export async function listApplicationDomains(
  applicationId: string,
): Promise<ListApplicationDomainsResponse> {
  const url = new URL(`/v1/platform/applications/${applicationId}/domains`, getPlapiBaseUrl());
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<ListApplicationDomainsResponse>;
}

export async function createProductionInstance(
  applicationId: string,
  params: CreateProductionInstanceParams,
): Promise<ProductionInstanceResponse> {
  const url = new URL(`/v1/platform/applications/${applicationId}/instances`, getPlapiBaseUrl());
  const response = await plapiFetch("POST", url, { body: JSON.stringify(params) });
  return response.json() as Promise<ProductionInstanceResponse>;
}

export async function getApplicationDomainStatus(
  applicationId: string,
  domainIdOrName: string,
): Promise<DomainStatusResponse> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/domains/${domainIdOrName}/status`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<DomainStatusResponse>;
}

export async function triggerApplicationDomainDNSCheck(
  applicationId: string,
  domainIdOrName: string,
): Promise<TriggerDNSCheckResponse> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/domains/${domainIdOrName}/dns_check`,
    getPlapiBaseUrl(),
  );
  const response = await plapiFetch("POST", url);
  return response.json() as Promise<TriggerDNSCheckResponse>;
}

export type InstanceConfigMutationOptions = {
  destructive?: boolean;
  dryRun?: boolean;
  ifMatch?: string;
};

async function sendInstanceConfig(
  method: "PUT" | "PATCH",
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: InstanceConfigMutationOptions,
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/config`,
    getPlapiBaseUrl(),
  );
  if (options?.destructive) {
    url.searchParams.set("destructive", "true");
  }
  if (options?.dryRun) {
    url.searchParams.set("dry_run", "true");
  }
  const response = await plapiFetch(method, url, {
    body: JSON.stringify(config),
    ifMatch: options?.ifMatch,
  });
  return response.json() as Promise<Record<string, unknown>>;
}

export const putInstanceConfig = async (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: InstanceConfigMutationOptions,
) => sendInstanceConfig("PUT", applicationId, instanceId, config, options);

export const patchInstanceConfig = async (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: InstanceConfigMutationOptions,
) => sendInstanceConfig("PATCH", applicationId, instanceId, config, options);

export async function createApplication(name: string): Promise<Application> {
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await plapiFetch("POST", url, {
    body: JSON.stringify({ name, from_source: CLI_FROM_SOURCE }),
  });
  return response.json() as Promise<Application>;
}

export async function claimApplication(token: string, name: string): Promise<Application> {
  const url = new URL("/v1/platform/accountless_applications/claim", getPlapiBaseUrl());
  const response = await plapiFetch("POST", url, { body: JSON.stringify({ token, name }) });
  return response.json() as Promise<Application>;
}

export async function listApplications(): Promise<Application[]> {
  const url = new URL("/v1/platform/applications", getPlapiBaseUrl());
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Application[]>;
}
