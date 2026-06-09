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

export async function fetchApplication(applicationId: string): Promise<Application> {
  const url = new URL(`/v1/platform/applications/${applicationId}`, getPlapiBaseUrl());
  url.searchParams.set("include_secret_keys", "true");
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<Application>;
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

async function sendInstanceConfig(
  method: "PUT" | "PATCH",
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean; dryRun?: boolean },
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
  const response = await plapiFetch(method, url, { body: JSON.stringify(config) });
  return response.json() as Promise<Record<string, unknown>>;
}

export const putInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean; dryRun?: boolean },
) => sendInstanceConfig("PUT", applicationId, instanceId, config, options);

export const patchInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
  options?: { destructive?: boolean; dryRun?: boolean },
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

// ── Webhooks (instance-scoped /webhooks routes) ──────────────────────────

export type WebhookEndpoint = {
  id: string;
  url: string;
  version: number;
  description?: string;
  disabled: boolean;
  filter_types?: string[] | null;
  channels?: string[] | null;
  created_at: string;
  updated_at: string;
};

export type WebhookCursor = {
  starting_after: string | null;
  ending_before: string | null;
  has_next_page: boolean;
};

export type WebhookEndpointList = {
  data: WebhookEndpoint[];
  cursor: WebhookCursor;
};

export type WebhookEventType = {
  name: string;
  description?: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type WebhookEventTypeList = {
  data: WebhookEventType[];
  cursor: WebhookCursor;
};

export const WEBHOOK_MESSAGE_STATUSES = ["success", "pending", "fail", "sending"] as const;
export type WebhookMessageStatus = (typeof WEBHOOK_MESSAGE_STATUSES)[number];

export type WebhookMessage = {
  id: string;
  event_type: string;
  status: WebhookMessageStatus;
  next_attempt: string | null;
  payload: unknown;
  created_at: string;
};

export type WebhookMessageList = {
  data: WebhookMessage[];
  cursor: WebhookCursor;
};

export type CreateWebhookEndpointParams = {
  url: string;
  version: 1;
  description?: string;
  disabled?: boolean;
  filter_types?: string[];
  channels?: string[];
};

export type UpdateWebhookEndpointParams = Partial<CreateWebhookEndpointParams>;

export type WebhookPageParams = {
  limit?: number;
  iterator?: string;
};

function webhooksUrl(applicationId: string, instanceId: string, path = ""): URL {
  return new URL(
    `/v1/platform/applications/${applicationId}/instances/${instanceId}/webhooks${path}`,
    getPlapiBaseUrl(),
  );
}

/**
 * The CLI flag is `--iterator` (the Svix pagination concept); the wire query
 * param is Clerk's cursor convention `starting_after`. The translation lives
 * here so commands never see the wire name.
 */
function appendPageParams(url: URL, params?: WebhookPageParams): void {
  if (typeof params?.limit === "number") {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params?.iterator) {
    url.searchParams.set("starting_after", params.iterator);
  }
}

export async function listWebhookEndpoints(
  applicationId: string,
  instanceId: string,
  params?: WebhookPageParams,
): Promise<WebhookEndpointList> {
  const url = webhooksUrl(applicationId, instanceId);
  appendPageParams(url, params);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<WebhookEndpointList>;
}

export async function getWebhookEndpoint(
  applicationId: string,
  instanceId: string,
  endpointId: string,
): Promise<WebhookEndpoint> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}`);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<WebhookEndpoint>;
}

export async function createWebhookEndpoint(
  applicationId: string,
  instanceId: string,
  params: CreateWebhookEndpointParams,
): Promise<WebhookEndpoint> {
  const url = webhooksUrl(applicationId, instanceId);
  const response = await plapiFetch("POST", url, { body: JSON.stringify(params) });
  return response.json() as Promise<WebhookEndpoint>;
}

export async function updateWebhookEndpoint(
  applicationId: string,
  instanceId: string,
  endpointId: string,
  params: UpdateWebhookEndpointParams,
): Promise<WebhookEndpoint> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}`);
  const response = await plapiFetch("PATCH", url, { body: JSON.stringify(params) });
  return response.json() as Promise<WebhookEndpoint>;
}

export async function deleteWebhookEndpoint(
  applicationId: string,
  instanceId: string,
  endpointId: string,
): Promise<void> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}`);
  await plapiFetch("DELETE", url);
}

export async function getWebhookEndpointSecret(
  applicationId: string,
  instanceId: string,
  endpointId: string,
): Promise<{ secret: string }> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/secret`);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<{ secret: string }>;
}

export async function rotateWebhookEndpointSecret(
  applicationId: string,
  instanceId: string,
  endpointId: string,
): Promise<void> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/secret/rotate`);
  await plapiFetch("POST", url);
}

export async function listWebhookEventTypes(
  applicationId: string,
  instanceId: string,
  params?: WebhookPageParams,
): Promise<WebhookEventTypeList> {
  const url = webhooksUrl(applicationId, instanceId, "/event_types");
  appendPageParams(url, params);
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<WebhookEventTypeList>;
}

export async function listWebhookMessages(
  applicationId: string,
  instanceId: string,
  endpointId: string,
  params?: WebhookPageParams & { status?: WebhookMessageStatus },
): Promise<WebhookMessageList> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/messages`);
  appendPageParams(url, params);
  if (params?.status) {
    url.searchParams.set("status", params.status);
  }
  const response = await plapiFetch("GET", url);
  return response.json() as Promise<WebhookMessageList>;
}

export async function resendWebhookMessage(
  applicationId: string,
  instanceId: string,
  endpointId: string,
  messageId: string,
): Promise<void> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/messages/${messageId}/resend`);
  await plapiFetch("POST", url);
}

export async function recoverWebhookMessages(
  applicationId: string,
  instanceId: string,
  endpointId: string,
  window: { since: string; until?: string },
): Promise<void> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/recover`);
  const body: { since: string; until?: string } = { since: window.since };
  if (window.until) body.until = window.until;
  await plapiFetch("POST", url, { body: JSON.stringify(body) });
}

export async function sendWebhookExample(
  applicationId: string,
  instanceId: string,
  endpointId: string,
  eventType: string,
): Promise<void> {
  const url = webhooksUrl(applicationId, instanceId, `/${endpointId}/send_example`);
  await plapiFetch("POST", url, { body: JSON.stringify({ event_type: eventType }) });
}

export async function getWebhookPortalUrl(
  applicationId: string,
  instanceId: string,
): Promise<{ url: string }> {
  const url = webhooksUrl(applicationId, instanceId, "/url");
  const response = await plapiFetch("POST", url, { body: JSON.stringify({}) });
  return response.json() as Promise<{ url: string }>;
}
