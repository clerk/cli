import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockPlapiCreateProductionInstance = mock();
const mockPlapiValidateCloning = mock();
const mockPlapiGetDeployStatus = mock();
const mockPlapiPatchInstanceConfig = mock();
const mockPlapiRetryApplicationDomainSSL = mock();
const mockPlapiRetryApplicationDomainMail = mock();
const mockSleep = mock();

mock.module("../../lib/plapi.ts", () => ({
  createProductionInstance: (...args: unknown[]) => mockPlapiCreateProductionInstance(...args),
  validateCloning: (...args: unknown[]) => mockPlapiValidateCloning(...args),
  getDeployStatus: (...args: unknown[]) => mockPlapiGetDeployStatus(...args),
  patchInstanceConfig: (...args: unknown[]) => mockPlapiPatchInstanceConfig(...args),
  retryApplicationDomainSSL: (...args: unknown[]) => mockPlapiRetryApplicationDomainSSL(...args),
  retryApplicationDomainMail: (...args: unknown[]) => mockPlapiRetryApplicationDomainMail(...args),
}));

mock.module("../../lib/sleep.ts", () => ({
  sleep: (...args: unknown[]) => mockSleep(...args),
}));

const deployApiModulePath = "./api.ts?adapter-test";
const apiModule = (await import(deployApiModulePath)) as typeof import("./api.ts");
const mockModule = (await import("./mock.ts")) as typeof import("./mock.ts");
const { createProductionInstance, getDeployStatus, patchInstanceConfig, validateCloning } =
  apiModule;
const { configureMockDeployApi, _resetDeployStatusMock } = mockModule;

describe("deploy api adapter", () => {
  beforeEach(() => {
    mockPlapiCreateProductionInstance.mockImplementation(() => {
      throw new Error("live createProductionInstance should not be called");
    });
    mockPlapiValidateCloning.mockImplementation(() => {
      throw new Error("live validateCloning should not be called");
    });
    mockPlapiGetDeployStatus.mockImplementation(() => {
      throw new Error("live getDeployStatus should not be called");
    });
    mockPlapiPatchInstanceConfig.mockImplementation(() => {
      throw new Error("live patchInstanceConfig should not be called");
    });
    mockPlapiRetryApplicationDomainSSL.mockImplementation(() => {
      throw new Error("live retryApplicationDomainSSL should not be called");
    });
    mockPlapiRetryApplicationDomainMail.mockImplementation(() => {
      throw new Error("live retryApplicationDomainMail should not be called");
    });
    mockSleep.mockResolvedValue(undefined);
    _resetDeployStatusMock();
  });

  test("uses mocked deploy lifecycle operations by default", async () => {
    const production = await createProductionInstance("app_123", {
      home_url: "example.com",
      clone_instance_id: "ins_dev_123",
    });
    await validateCloning("app_123", { clone_instance_id: "ins_dev_123" });
    await patchInstanceConfig("app_123", production.instance_id, {
      connection_oauth_google: { enabled: true },
    });

    expect(production.instance_id).toBe("MOCKED_NOT_REAL_FIXME");
    expect(production.active_domain?.name).toBe("example.com");
    expect(production.cname_targets).toHaveLength(3);
    expect(mockPlapiCreateProductionInstance).not.toHaveBeenCalled();
    expect(mockPlapiValidateCloning).not.toHaveBeenCalled();
    expect(mockPlapiPatchInstanceConfig).not.toHaveBeenCalled();
  });

  test("mock deploy status represents incomplete then complete server state", async () => {
    expect(await getDeployStatus("app_123", "ins_prod_123")).toEqual({ status: "incomplete" });
    expect(await getDeployStatus("app_123", "ins_prod_123")).toEqual({ status: "incomplete" });
    expect(await getDeployStatus("app_123", "ins_prod_123")).toEqual({ status: "complete" });
    expect(mockPlapiGetDeployStatus).not.toHaveBeenCalled();
  });

  test("mock deploy api can fail lifecycle operations with PLAPI-shaped errors", async () => {
    configureMockDeployApi({
      failValidateCloning: true,
      failCreateProductionInstance: true,
      failDnsVerification: true,
      failOAuthSave: true,
    });

    await expect(validateCloning("app_123", { clone_instance_id: "ins_dev_123" })).rejects.toThrow(
      "Simulated deploy failure: cloning validation.",
    );
    await expect(
      createProductionInstance("app_123", {
        home_url: "example.com",
        clone_instance_id: "ins_dev_123",
      }),
    ).rejects.toThrow("Simulated deploy failure: production instance creation.");
    await expect(getDeployStatus("app_123", "ins_prod_123")).rejects.toThrow(
      "Simulated deploy failure: DNS verification.",
    );
    await expect(
      patchInstanceConfig("app_123", "ins_prod_123", {
        connection_oauth_google: { enabled: true },
      }),
    ).rejects.toThrow("Simulated deploy failure: OAuth credential save.");

    expect(mockPlapiValidateCloning).not.toHaveBeenCalled();
    expect(mockPlapiCreateProductionInstance).not.toHaveBeenCalled();
    expect(mockPlapiGetDeployStatus).not.toHaveBeenCalled();
    expect(mockPlapiPatchInstanceConfig).not.toHaveBeenCalled();
  });

  test("reset mock deploy api clears lifecycle failure flags", async () => {
    configureMockDeployApi({ failValidateCloning: true });
    _resetDeployStatusMock();

    await expect(
      validateCloning("app_123", { clone_instance_id: "ins_dev_123" }),
    ).resolves.toBeUndefined();
  });
});
