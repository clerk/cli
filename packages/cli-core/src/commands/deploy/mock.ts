/**
 * Test-only mocked deploy lifecycle.
 *
 * The deploy command runs against this in-process mock until the production-
 * instance backend is built. All test-flag plumbing and failure-injection
 * helpers also live here so the surface to delete when the real backend
 * lands is obvious.
 */

import { sleep } from "../../lib/sleep.ts";
import { PlapiError } from "../../lib/errors.ts";
import type { Application, ApplicationDomain } from "../../lib/plapi.ts";
import type { CnameTarget, DeployApi } from "./api.ts";

const MOCK_PRODUCTION_INSTANCE_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_DOMAIN_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_PUBLISHABLE_KEY = "MOCKED_NOT_REAL_FIXME";
const MOCK_SECRET_KEY = "MOCKED_NOT_REAL_FIXME";
const MOCK_LATENCY_MS = 2000;
const MOCK_INCOMPLETE_POLLS = 2;

export type DeployApiMockOptions = {
  failValidateCloning?: boolean;
  /** Simulates HTTP 402 unsupported_subscription_plan_features with this feature list. */
  failValidateCloningUnsupportedFeatures?: string[];
  failCreateProductionInstance?: boolean;
  /** Simulates HTTP 400 production_instance_exists. */
  failCreateProductionInstanceExists?: boolean;
  failDnsVerification?: boolean;
  failOAuthSave?: boolean;
};

export type DeployTestFlags = {
  testForceProductionInstance?: boolean;
  testFailProductionInstanceCheck?: boolean;
  testFailDomainLookup?: boolean;
  testFailValidateCloning?: boolean;
  testFailValidateCloningUnsupportedFeatures?: string[];
  testFailCreateProductionInstance?: boolean;
  testFailCreateProductionInstanceExists?: boolean;
  testFailDnsVerification?: boolean;
  testFailOAuthSave?: boolean;
};

let mockOptions: DeployApiMockOptions = {};

export function configureMockDeployApi(options: DeployApiMockOptions = {}): void {
  mockOptions = { ...options };
}

export function resolveTestDeployFlags(options: {
  testForceProductionInstance?: boolean;
  testFailProductionInstanceCheck?: boolean;
  testFailDomainLookup?: boolean;
  testFailValidateCloning?: boolean;
  testFailValidateCloningUnsupportedFeatures?: string[];
  testFailCreateProductionInstance?: boolean;
  testFailCreateProductionInstanceExists?: boolean;
  testFailDnsVerification?: boolean;
  testFailOAuthSave?: boolean;
}): DeployTestFlags {
  return {
    testForceProductionInstance: options.testForceProductionInstance === true,
    testFailProductionInstanceCheck: options.testFailProductionInstanceCheck === true,
    testFailDomainLookup: options.testFailDomainLookup === true,
    testFailValidateCloning: options.testFailValidateCloning === true,
    testFailValidateCloningUnsupportedFeatures: options.testFailValidateCloningUnsupportedFeatures,
    testFailCreateProductionInstance: options.testFailCreateProductionInstance === true,
    testFailCreateProductionInstanceExists: options.testFailCreateProductionInstanceExists === true,
    testFailDnsVerification: options.testFailDnsVerification === true,
    testFailOAuthSave: options.testFailOAuthSave === true,
  };
}

export function simulatedDeployApiFailure(step: string): PlapiError {
  return PlapiError.fromBody(
    500,
    JSON.stringify({ errors: [{ message: `Simulated deploy failure: ${step}.` }] }),
    "clerk deploy test flag",
  );
}

export async function withTestFailureAfterApiCall<T>(
  promise: Promise<T>,
  shouldFail: boolean | undefined,
  step: string,
): Promise<T> {
  const result = await promise;
  if (shouldFail) {
    throw simulatedDeployApiFailure(step);
  }
  return result;
}

async function simulateServerLatency(): Promise<void> {
  await sleep(MOCK_LATENCY_MS);
}

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

const deployStatusPollCounts = new Map<string, number>();

export function _resetDeployStatusMock(): void {
  deployStatusPollCounts.clear();
  configureMockDeployApi();
}

function simulatedSpecificFailure(
  status: number,
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): PlapiError {
  const body = JSON.stringify({
    errors: [{ code, message, ...(meta ? { meta } : {}) }],
  });
  return PlapiError.fromBody(status, body, "clerk deploy mock");
}

export const mockDeployApi: DeployApi = {
  async createProductionInstance(_applicationId, params) {
    await simulateServerLatency();
    if (mockOptions.failCreateProductionInstance) {
      throw simulatedDeployApiFailure("production instance creation");
    }
    if (mockOptions.failCreateProductionInstanceExists) {
      throw simulatedSpecificFailure(
        400,
        "production_instance_exists",
        "You can only have one production instance.",
      );
    }
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
  },

  async validateCloning() {
    await simulateServerLatency();
    if (mockOptions.failValidateCloning) {
      throw simulatedDeployApiFailure("cloning validation");
    }
    if (mockOptions.failValidateCloningUnsupportedFeatures) {
      throw simulatedSpecificFailure(
        402,
        "unsupported_subscription_plan_features",
        "Unsupported plan features",
        { unsupported_features: mockOptions.failValidateCloningUnsupportedFeatures },
      );
    }
  },

  async getDeployStatus(applicationId, envOrInsId) {
    await simulateServerLatency();
    if (mockOptions.failDnsVerification) {
      throw simulatedDeployApiFailure("DNS verification");
    }
    const key = `${applicationId}:${envOrInsId}`;
    const count = (deployStatusPollCounts.get(key) ?? 0) + 1;
    deployStatusPollCounts.set(key, count);
    return {
      status: count > MOCK_INCOMPLETE_POLLS ? "complete" : "incomplete",
    };
  },

  async retryApplicationDomainSSL() {
    await simulateServerLatency();
  },

  async retryApplicationDomainMail() {
    await simulateServerLatency();
  },

  async patchInstanceConfig() {
    await simulateServerLatency();
    if (mockOptions.failOAuthSave) {
      throw simulatedDeployApiFailure("OAuth credential save");
    }
    return {};
  },
};

export function withMockProductionInstance(app: Application): Application {
  if (app.instances.some((entry) => entry.environment_type === "production")) {
    return app;
  }
  return {
    ...app,
    instances: [
      ...app.instances,
      {
        instance_id: "ins_prod_mock",
        environment_type: "production",
        publishable_key: "pk_live_test",
      },
    ],
  };
}

export function mockProductionDomain(): ApplicationDomain {
  return {
    object: "domain",
    id: "dmn_prod_mock",
    name: "example.com",
    is_satellite: false,
    is_provider_domain: false,
    frontend_api_url: "https://clerk.example.com",
    accounts_portal_url: "https://accounts.example.com",
    development_origin: "",
    cname_targets: [
      { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
      { host: "accounts.example.com", value: "accounts.clerk.services", required: true },
      {
        host: "clkmail.example.com",
        value: "mail.example.com.nam1.clerk.services",
        required: true,
      },
    ],
    created_at: "2026-05-06T00:00:00Z",
    updated_at: "2026-05-06T00:00:00Z",
  };
}

export function mockProductionInstanceConfig(): Record<string, unknown> {
  return {};
}
