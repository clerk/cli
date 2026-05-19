import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockPlapiCreateProductionInstance = mock();
const mockPlapiValidateCloning = mock();
const mockPlapiGetDeployStatus = mock();
const mockPlapiPatchInstanceConfig = mock();
const mockPlapiRetryApplicationDomainSSL = mock();
const mockPlapiRetryApplicationDomainMail = mock();

mock.module("../../lib/plapi.ts", () => ({
  createProductionInstance: (...args: unknown[]) => mockPlapiCreateProductionInstance(...args),
  validateCloning: (...args: unknown[]) => mockPlapiValidateCloning(...args),
  getDeployStatus: (...args: unknown[]) => mockPlapiGetDeployStatus(...args),
  patchInstanceConfig: (...args: unknown[]) => mockPlapiPatchInstanceConfig(...args),
  retryApplicationDomainSSL: (...args: unknown[]) => mockPlapiRetryApplicationDomainSSL(...args),
  retryApplicationDomainMail: (...args: unknown[]) => mockPlapiRetryApplicationDomainMail(...args),
}));

const deployApiModulePath = "./api.ts?adapter-test";
const apiModule = (await import(deployApiModulePath)) as typeof import("./api.ts");
const {
  createProductionInstance,
  getDeployStatus,
  patchInstanceConfig,
  retryApplicationDomainMail,
  retryApplicationDomainSSL,
  validateCloning,
} = apiModule;

describe("deploy api adapter (live routing)", () => {
  beforeEach(() => {
    mockPlapiCreateProductionInstance.mockReset();
    mockPlapiValidateCloning.mockReset();
    mockPlapiGetDeployStatus.mockReset();
    mockPlapiPatchInstanceConfig.mockReset();
    mockPlapiRetryApplicationDomainSSL.mockReset();
    mockPlapiRetryApplicationDomainMail.mockReset();
  });

  test("createProductionInstance delegates to lib/plapi.ts", async () => {
    mockPlapiCreateProductionInstance.mockResolvedValue({
      instance_id: "ins_prod_live",
      environment_type: "production",
      active_domain: { id: "dmn_live", name: "example.com" },
      publishable_key: "pk_live_test",
      cname_targets: [],
    });

    const result = await createProductionInstance("app_123", {
      home_url: "example.com",
      clone_instance_id: "ins_dev_123",
    });

    expect(mockPlapiCreateProductionInstance).toHaveBeenCalledWith("app_123", {
      home_url: "example.com",
      clone_instance_id: "ins_dev_123",
    });
    expect(result.instance_id).toBe("ins_prod_live");
  });

  test("validateCloning delegates to lib/plapi.ts", async () => {
    mockPlapiValidateCloning.mockResolvedValue(undefined);
    await validateCloning("app_123", { clone_instance_id: "ins_dev_123" });
    expect(mockPlapiValidateCloning).toHaveBeenCalledWith("app_123", {
      clone_instance_id: "ins_dev_123",
    });
  });

  test("getDeployStatus delegates to lib/plapi.ts and surfaces booleans", async () => {
    mockPlapiGetDeployStatus.mockResolvedValue({
      status: "incomplete",
      dns_ok: true,
      ssl_ok: false,
      mail_ok: false,
    });
    const result = await getDeployStatus("app_123", "production");
    expect(mockPlapiGetDeployStatus).toHaveBeenCalledWith("app_123", "production");
    expect(result).toEqual({
      status: "incomplete",
      dns_ok: true,
      ssl_ok: false,
      mail_ok: false,
    });
  });

  test("patchInstanceConfig delegates to lib/plapi.ts", async () => {
    mockPlapiPatchInstanceConfig.mockResolvedValue({ ok: true });
    const result = await patchInstanceConfig("app_123", "ins_prod_live", {
      connection_oauth_google: { enabled: true },
    });
    expect(mockPlapiPatchInstanceConfig).toHaveBeenCalledWith("app_123", "ins_prod_live", {
      connection_oauth_google: { enabled: true },
    });
    expect(result).toEqual({ ok: true });
  });

  test("retryApplicationDomainSSL delegates to lib/plapi.ts", async () => {
    mockPlapiRetryApplicationDomainSSL.mockResolvedValue(undefined);
    await retryApplicationDomainSSL("app_123", "example.com");
    expect(mockPlapiRetryApplicationDomainSSL).toHaveBeenCalledWith("app_123", "example.com");
  });

  test("retryApplicationDomainMail delegates to lib/plapi.ts", async () => {
    mockPlapiRetryApplicationDomainMail.mockResolvedValue(undefined);
    await retryApplicationDomainMail("app_123", "example.com");
    expect(mockPlapiRetryApplicationDomainMail).toHaveBeenCalledWith("app_123", "example.com");
  });
});
