import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PlapiError } from "../../lib/errors.ts";

const mockFetchApplication = mock();
const mockListApplicationDomains = mock();
const mockFetchInstanceConfig = mock();
const mockFetchInstanceConfigSchema = mock();
const mockGetApplicationDomainStatus = mock();
const mockTriggerApplicationDomainDNSCheck = mock();

mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  listApplicationDomains: (...args: unknown[]) => mockListApplicationDomains(...args),
  fetchInstanceConfig: (...args: unknown[]) => mockFetchInstanceConfig(...args),
  fetchInstanceConfigSchema: (...args: unknown[]) => mockFetchInstanceConfigSchema(...args),
  getApplicationDomainStatus: (...args: unknown[]) => mockGetApplicationDomainStatus(...args),
  triggerApplicationDomainDNSCheck: (...args: unknown[]) =>
    mockTriggerApplicationDomainDNSCheck(...args),
}));

const { resolveDeployState, waitForDeployStatus } = await import("./status.ts");

const ctx = {
  profileKey: "/tmp/x",
  profile: {
    workspaceId: "",
    appId: "app_1",
    instances: { development: "ins_dev" },
  },
  appId: "app_1",
  appLabel: "app_1",
  developmentInstanceId: "ins_dev",
} as const;

const completeStatus = {
  status: "complete",
  dns: { status: "complete" },
  ssl: { status: "complete", required: true },
  mail: { status: "complete", required: true },
};

const passthroughHandlers = {
  runComponent: <T>(
    _component: unknown,
    _label: string,
    work: (controls: { update: () => void }) => Promise<T>,
  ) => work({ update: () => {} }),
};

beforeEach(() => {
  mockFetchInstanceConfig.mockResolvedValue({});
  mockFetchInstanceConfigSchema.mockResolvedValue({ properties: {} });
});

afterEach(() => {
  mockFetchApplication.mockReset();
  mockListApplicationDomains.mockReset();
  mockFetchInstanceConfig.mockReset();
  mockFetchInstanceConfigSchema.mockReset();
  mockGetApplicationDomainStatus.mockReset();
  mockTriggerApplicationDomainDNSCheck.mockReset();
});

describe("resolveDeployState", () => {
  test("returns not_started when the application has no production instance", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_1",
      name: "app",
      instances: [{ instance_id: "ins_dev", environment_type: "development" }],
    });

    const state = await resolveDeployState({ ...ctx });

    expect(state.kind).toBe("not_started");
  });

  test("returns domain_provisioning when production instance exists but has no domain", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_1",
      name: "app",
      instances: [
        { instance_id: "ins_dev", environment_type: "development" },
        { instance_id: "ins_prod", environment_type: "production" },
      ],
    });
    mockListApplicationDomains.mockResolvedValue({ data: [], total_count: 0 });

    const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

    expect(state).toEqual({
      kind: "domain_provisioning",
      productionInstanceId: "ins_prod",
    });
  });

  test("returns active with a snapshot when instance and domain exist", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_1",
      name: "app",
      instances: [
        { instance_id: "ins_dev", environment_type: "development" },
        { instance_id: "ins_prod", environment_type: "production" },
      ],
    });
    mockListApplicationDomains.mockResolvedValue({
      data: [
        {
          object: "domain",
          id: "dmn_1",
          name: "example.com",
          is_satellite: false,
          is_provider_domain: false,
          frontend_api_url: "https://clerk.example.com",
          accounts_portal_url: "https://accounts.example.com",
          development_origin: "",
          cname_targets: [
            {
              host: "clerk.example.com",
              value: "frontend-api.clerk.services",
              required: true,
            },
          ],
        },
      ],
      total_count: 1,
    });
    mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) =>
      instanceId === "ins_prod"
        ? { connection_oauth_google: { enabled: true, client_id: "id", client_secret: "secret" } }
        : { connection_oauth_google: { enabled: true } },
    );
    mockFetchInstanceConfigSchema.mockResolvedValue({
      properties: {
        connection_oauth_google: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            client_id: { type: "string" },
            client_secret: { type: "string", "x-clerk-sensitive": true },
          },
        },
      },
    });
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

    expect(state.kind).toBe("active");
    if (state.kind === "active") {
      expect(state.snapshot.domain).toBe("example.com");
      expect(state.snapshot.domainComplete).toBe(true);
      expect(state.snapshot.oauthProviders).toEqual(["google"]);
      expect(state.snapshot.completedOAuthProviders).toEqual(["google"]);
    }
  });
});

describe("waitForDeployStatus", () => {
  test("triggers a DNS check before polling and returns verified when complete", async () => {
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeStatus);
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const outcome = await waitForDeployStatus("app_1", "dmn_1", "example.com", passthroughHandlers);

    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
    expect(mockTriggerApplicationDomainDNSCheck.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetApplicationDomainStatus.mock.invocationCallOrder[0]!,
    );
    expect(outcome).toEqual({
      verified: true,
      status: { dns: true, ssl: true, mail: true },
    });
  });

  test("continues polling when the DNS check is already in flight", async () => {
    mockTriggerApplicationDomainDNSCheck.mockRejectedValue(
      new PlapiError(409, JSON.stringify({ errors: [{ code: "conflict" }] }), "https://x"),
    );
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const outcome = await waitForDeployStatus("app_1", "dmn_1", "example.com", passthroughHandlers);

    expect(outcome).toEqual({
      verified: true,
      status: { dns: true, ssl: true, mail: true },
    });
  });
});
