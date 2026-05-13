/**
 * Deploy command API adapter.
 *
 * Live endpoint wrappers live in `lib/plapi.ts`, but the deploy lifecycle
 * remains mocked while the production-instance backend settles. Keep this
 * adapter as the switch point: the command resolves deploy progress through
 * API-shaped calls, while these lifecycle operations simulate backend states
 * locally.
 */

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
import { mockDeployApi } from "./mock.ts";

export { configureMockDeployApi } from "./mock.ts";

export type {
  CnameTarget,
  CreateProductionInstanceParams,
  DeployStatusResponse,
  ProductionInstanceResponse,
  ValidateCloningParams,
} from "../../lib/plapi.ts";

export type DeployApi = {
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
