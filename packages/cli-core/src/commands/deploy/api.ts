/**
 * FIXME(deploy): the entire module is a stand-in. Every export below is a
 * mock that must be replaced with the live Platform API call before
 * shipping the deploy command. Grep `FIXME(deploy)` to find each spot.
 *
 * Mock implementations of the deploy lifecycle Platform API endpoints.
 *
 * Type signatures and field names mirror the published Platform API
 * OpenAPI spec exactly. Implementations are mocked so the CLI deploy
 * wizard runs end-to-end without a backend. Swapping these to live calls
 * is intentionally a one-function-at-a-time change with no shape
 * rewrites.
 *
 * Endpoint paths:
 *   POST   /v1/platform/applications/{applicationID}/production_instance
 *   POST   /v1/platform/applications/{applicationID}/validate_cloning
 *   GET    /v1/platform/applications/{applicationID}/instances/{envOrInsID}/deploy_status
 *   POST   /v1/platform/applications/{applicationID}/domains/{domainIDOrName}/ssl_retry
 *   POST   /v1/platform/applications/{applicationID}/domains/{domainIDOrName}/mail_retry
 *   PATCH  /v1/platform/applications/{applicationID}/instances/{instanceID}/config
 */

import { log } from "../../lib/log.ts";
import { sleep } from "../../lib/sleep.ts";

export type DomainSummary = {
  id: string;
  name: string;
};

export type CnameTarget = {
  host: string;
  value: string;
  required: boolean;
};

export type ProductionInstanceResponse = {
  instance_id: string;
  environment_type: "production";
  active_domain: DomainSummary;
  secret_key?: string;
  publishable_key: string;
  cname_targets: CnameTarget[];
};

export type CreateProductionInstanceParams = {
  home_url: string;
  clone_instance_id?: string;
  is_secondary?: boolean;
};

export type ValidateCloningParams = {
  clone_instance_id: string;
};

export type DeployStatus = "complete" | "incomplete";

export type DeployStatusResponse = {
  status: DeployStatus;
};

// FIXME(deploy): hardcoded mock identifiers and keys. Drop alongside the mock helpers below.
const MOCK_PRODUCTION_INSTANCE_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_DOMAIN_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_PUBLISHABLE_KEY = "MOCKED_NOT_REAL_FIXME";
const MOCK_SECRET_KEY = "MOCKED_NOT_REAL_FIXME";

/**
 * FIXME(deploy): artificial server-side latency every mocked endpoint
 * pays before returning. Exists so the wizard's spinners and DNS-status
 * polling feel like real network calls instead of instant resolution.
 * Remove the helper and every `await simulateServerLatency()` call site
 * once these endpoints hit the real network.
 */
const MOCK_LATENCY_MS = 2000;

async function simulateServerLatency(): Promise<void> {
  // FIXME(deploy): artificial delay. Remove when the surrounding mock is replaced with a real PLAPI call.
  await sleep(MOCK_LATENCY_MS);
}

/**
 * Mock for `POST /v1/platform/applications/{applicationID}/production_instance`.
 *
 * The real endpoint creates a prod instance + primary domain, optionally
 * cloning from a dev instance, and returns keys + DNS targets in one
 * round-trip.
 */
export async function createProductionInstance(
  applicationId: string,
  params: CreateProductionInstanceParams,
): Promise<ProductionInstanceResponse> {
  // FIXME(deploy): mock. Replace with a live POST to PLAPI and remove the hardcoded response.
  log.debug(
    `plapi-mock: POST /v1/platform/applications/${applicationId}/production_instance ` +
      `home_url=${params.home_url} clone_instance_id=${params.clone_instance_id ?? ""}`,
  );
  await simulateServerLatency();
  return {
    instance_id: MOCK_PRODUCTION_INSTANCE_ID,
    environment_type: "production",
    active_domain: {
      id: MOCK_DOMAIN_ID,
      name: params.home_url,
    },
    secret_key: MOCK_SECRET_KEY,
    publishable_key: MOCK_PUBLISHABLE_KEY,
    cname_targets: defaultCnameTargets(params.home_url),
  };
}

/**
 * Mock for `POST /v1/platform/applications/{applicationID}/validate_cloning`.
 *
 * The real endpoint validates that the dev instance's features are
 * covered by the application's subscription plan. Returns 204 on success
 * or 402 with UnsupportedSubscriptionPlanFeatures.
 */
export async function validateCloning(
  applicationId: string,
  params: ValidateCloningParams,
): Promise<void> {
  // FIXME(deploy): mock. Replace with a live POST to PLAPI; bubble 402 UnsupportedSubscriptionPlanFeatures.
  log.debug(
    `plapi-mock: POST /v1/platform/applications/${applicationId}/validate_cloning ` +
      `clone_instance_id=${params.clone_instance_id}`,
  );
  await simulateServerLatency();
}

/**
 * Mock for `GET /v1/platform/applications/{applicationID}/instances/{envOrInsID}/deploy_status`.
 *
 * The real endpoint reports whether DNS, SSL, Mail, and Proxy checks have
 * all passed for the instance's primary domain. `envOrInsID` accepts the
 * literal "production" or "development" shortcut in addition to instance
 * IDs.
 *
 * The mock keeps a per-process counter keyed by instance so callers
 * polling on a 3s interval observe a realistic incomplete → complete
 * progression without any extra wiring.
 */
// FIXME(deploy): per-process counter that drives the fake incomplete→complete progression. Drop with the helper below.
const deployStatusPollCounts = new Map<string, number>();
const MOCK_INCOMPLETE_POLLS = 2;

export async function getDeployStatus(
  applicationId: string,
  envOrInsId: string,
): Promise<DeployStatusResponse> {
  // FIXME(deploy): mock. Replace with a live GET to PLAPI. The real endpoint already returns the same shape.
  log.debug(
    `plapi-mock: GET /v1/platform/applications/${applicationId}/instances/${envOrInsId}/deploy_status`,
  );
  await simulateServerLatency();
  const key = `${applicationId}:${envOrInsId}`;
  const count = (deployStatusPollCounts.get(key) ?? 0) + 1;
  deployStatusPollCounts.set(key, count);
  return {
    status: count > MOCK_INCOMPLETE_POLLS ? "complete" : "incomplete",
  };
}

/** Test-only: reset the mock deploy-status progression counters. */
export function _resetDeployStatusMock(): void {
  deployStatusPollCounts.clear();
}

/**
 * Mock for `POST /v1/platform/applications/{applicationID}/domains/{domainIDOrName}/ssl_retry`.
 *
 * The real endpoint re-provisions the SSL certificate for a production
 * domain. Returns 204 on success, 400 InstanceNotLive if SSL setup hasn't
 * begun.
 */
export async function retryApplicationDomainSSL(
  applicationId: string,
  domainIdOrName: string,
): Promise<void> {
  // FIXME(deploy): mock. Replace with a live POST to PLAPI.
  log.debug(
    `plapi-mock: POST /v1/platform/applications/${applicationId}/domains/${domainIdOrName}/ssl_retry`,
  );
  await simulateServerLatency();
}

/**
 * Mock for `POST /v1/platform/applications/{applicationID}/domains/{domainIDOrName}/mail_retry`.
 *
 * The real endpoint re-schedules SendGrid mail verification. Rejected on
 * satellite domains (they inherit mail from the primary).
 */
export async function retryApplicationDomainMail(
  applicationId: string,
  domainIdOrName: string,
): Promise<void> {
  // FIXME(deploy): mock. Replace with a live POST to PLAPI; bubble OperationNotAllowedOnSatelliteDomain.
  log.debug(
    `plapi-mock: POST /v1/platform/applications/${applicationId}/domains/${domainIdOrName}/mail_retry`,
  );
  await simulateServerLatency();
}

/**
 * Mock for `PATCH /v1/platform/applications/{applicationID}/instances/{instanceID}/config`
 * scoped to the deploy command's production instance writes.
 *
 * The endpoint itself is real and exposed via `lib/plapi.ts` for other
 * commands, but the deploy wizard targets a mocked production instance, so a
 * live PATCH would 404. This mock keeps the call shape identical so swapping
 * back to live is a one-import change.
 */
export async function patchInstanceConfig(
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // FIXME(deploy): mock. Swap back to `lib/plapi.ts` `patchInstanceConfig` once the production instance is real.
  log.debug(
    `plapi-mock: PATCH /v1/platform/applications/${applicationId}/instances/${instanceId}/config ` +
      `keys=${Object.keys(config).join(",")}`,
  );
  await simulateServerLatency();
  return {};
}

// FIXME(deploy): hardcoded CNAME values that the real `production_instance` create response will populate.
function defaultCnameTargets(domain: string): CnameTarget[] {
  return [
    { host: `clerk.${domain}`, value: "frontend-api.clerk.services", required: true },
    { host: `accounts.${domain}`, value: "accounts.clerk.services", required: true },
    {
      host: `clkmail.${domain}`,
      value: `mail.${domain}.nam1.clerk.services`,
      required: true,
    },
  ];
}

/**
 * Detect whether the registrar for `domain` supports Domain Connect and
 * return the prefilled URL if so. Currently a placeholder that returns the
 * Cloudflare template unconditionally; a real implementation would look up
 * NS records and match the registrar against a provider table.
 *
 * FIXME(deploy): replace with NS-based registrar detection. Today every
 * caller is told their registrar is Cloudflare regardless of reality.
 */
export function domainConnectUrl(domain: string): string | undefined {
  return `https://domainconnect.cloudflare.com/v2/domainTemplates/providers/clerk.com/services/clerk-production/apply?domain=${domain}`;
}
