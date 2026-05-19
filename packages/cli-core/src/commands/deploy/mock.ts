/**
 * Test-only fixtures and failure-injection helpers for the deploy lifecycle.
 *
 * Used by the `--test-*` flags so the e2e harness can drive the wizard
 * deterministically. Production code never reads these.
 */

import { PlapiError } from "../../lib/errors.ts";
import type { Application, ApplicationDomain } from "../../lib/plapi.ts";

export type DeployTestFlags = {
  testForceProductionInstance?: boolean;
  testFailProductionInstanceCheck?: boolean;
  testFailDomainLookup?: boolean;
  testFailValidateCloning?: boolean;
  testFailCreateProductionInstance?: boolean;
  testFailDnsVerification?: boolean;
  testFailOAuthSave?: boolean;
};

export function resolveTestDeployFlags(options: DeployTestFlags): DeployTestFlags {
  return {
    testForceProductionInstance: options.testForceProductionInstance === true,
    testFailProductionInstanceCheck: options.testFailProductionInstanceCheck === true,
    testFailDomainLookup: options.testFailDomainLookup === true,
    testFailValidateCloning: options.testFailValidateCloning === true,
    testFailCreateProductionInstance: options.testFailCreateProductionInstance === true,
    testFailDnsVerification: options.testFailDnsVerification === true,
    testFailOAuthSave: options.testFailOAuthSave === true,
  };
}

export function simulatedDeployApiFailure(step: string): PlapiError {
  return new PlapiError(
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
