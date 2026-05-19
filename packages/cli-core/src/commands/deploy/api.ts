/**
 * Deploy command API surface.
 *
 * Re-exports the PLAPI endpoints the deploy lifecycle calls so the test suite
 * can substitute the whole adapter via `mock.module("./api.ts", ...)` without
 * mocking each plapi call site individually.
 */

export {
  createProductionInstance,
  getDeployStatus,
  patchInstanceConfig,
  retryApplicationDomainMail,
  retryApplicationDomainSSL,
  validateCloning,
} from "../../lib/plapi.ts";

export type {
  CnameTarget,
  CreateProductionInstanceParams,
  DeployStatusResponse,
  ProductionInstanceResponse,
  ValidateCloningParams,
} from "../../lib/plapi.ts";

export type DeployApiMockOptions = {
  failValidateCloning?: boolean;
  failCreateProductionInstance?: boolean;
  failDnsVerification?: boolean;
  failOAuthSave?: boolean;
};

/**
 * No-op in production. Tests replace this via `mock.module("./api.ts", ...)`
 * to intercept the call and inject lifecycle failures into the mocked
 * `createProductionInstance` / `validateCloning` / `getDeployStatus` /
 * `patchInstanceConfig` exports above.
 */
export function configureMockDeployApi(_options: DeployApiMockOptions = {}): void {}
