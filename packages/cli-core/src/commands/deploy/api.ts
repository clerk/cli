/**
 * Deploy command API adapter.
 *
 * Live endpoint wrappers live in `lib/plapi.ts`, but the deploy lifecycle
 * remains mocked while the production-instance backend settles. Keep this
 * adapter as the switch point: the command resolves deploy progress through
 * API-shaped calls, while these lifecycle operations simulate backend states
 * locally.
 */

import { sleep } from "../../lib/sleep.ts";
import {
  createProductionInstance as liveCreateProductionInstance,
  getDeployStatus as liveGetDeployStatus,
  patchInstanceConfig as livePatchInstanceConfig,
  retryApplicationDomainMail as liveRetryApplicationDomainMail,
  retryApplicationDomainSSL as liveRetryApplicationDomainSSL,
  validateCloning as liveValidateCloning,
  type CnameTarget,
  type CreateProductionInstanceParams,
  type DeployStatusResponse,
  type ProductionInstanceResponse,
  type ValidateCloningParams,
} from "../../lib/plapi.ts";

export type {
  CnameTarget,
  CreateProductionInstanceParams,
  DeployStatusResponse,
  ProductionInstanceResponse,
  ValidateCloningParams,
} from "../../lib/plapi.ts";

type DeployApi = {
  createProductionInstance: (
    applicationId: string,
    params: CreateProductionInstanceParams,
  ) => Promise<ProductionInstanceResponse>;
  validateCloning: (applicationId: string, params: ValidateCloningParams) => Promise<void>;
  getDeployStatus: (applicationId: string, envOrInsId: string) => Promise<DeployStatusResponse>;
  retryApplicationDomainSSL: (applicationId: string, domainIdOrName: string) => Promise<void>;
  retryApplicationDomainMail: (applicationId: string, domainIdOrName: string) => Promise<void>;
  patchInstanceConfig: (
    applicationId: string,
    instanceId: string,
    config: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const MOCK_PRODUCTION_INSTANCE_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_DOMAIN_ID = "MOCKED_NOT_REAL_FIXME";
const MOCK_PUBLISHABLE_KEY = "MOCKED_NOT_REAL_FIXME";
const MOCK_SECRET_KEY = "MOCKED_NOT_REAL_FIXME";
const MOCK_LATENCY_MS = 2000;
const MOCK_INCOMPLETE_POLLS = 2;

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
}

export const mockDeployApi: DeployApi = {
  async createProductionInstance(_applicationId, params) {
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
  },

  async validateCloning() {
    await simulateServerLatency();
  },

  async getDeployStatus(applicationId, envOrInsId) {
    await simulateServerLatency();
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
    return {};
  },
};

export const liveDeployApi: DeployApi = {
  createProductionInstance: liveCreateProductionInstance,
  validateCloning: liveValidateCloning,
  getDeployStatus: liveGetDeployStatus,
  retryApplicationDomainSSL: liveRetryApplicationDomainSSL,
  retryApplicationDomainMail: liveRetryApplicationDomainMail,
  patchInstanceConfig: livePatchInstanceConfig,
};

const activeDeployApi: DeployApi = mockDeployApi;

export const createProductionInstance = (
  applicationId: string,
  params: CreateProductionInstanceParams,
) => activeDeployApi.createProductionInstance(applicationId, params);

export const validateCloning = (applicationId: string, params: ValidateCloningParams) =>
  activeDeployApi.validateCloning(applicationId, params);

export const getDeployStatus = (applicationId: string, envOrInsId: string) =>
  activeDeployApi.getDeployStatus(applicationId, envOrInsId);

export const retryApplicationDomainSSL = (applicationId: string, domainIdOrName: string) =>
  activeDeployApi.retryApplicationDomainSSL(applicationId, domainIdOrName);

export const retryApplicationDomainMail = (applicationId: string, domainIdOrName: string) =>
  activeDeployApi.retryApplicationDomainMail(applicationId, domainIdOrName);

export const patchInstanceConfig = (
  applicationId: string,
  instanceId: string,
  config: Record<string, unknown>,
) => activeDeployApi.patchInstanceConfig(applicationId, instanceId, config);
