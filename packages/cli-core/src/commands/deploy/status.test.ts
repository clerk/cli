import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PlapiError } from "../../lib/errors.ts";
import type { LiveDeploySnapshot } from "./status.ts";

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

const { buildDeployStatusReport, checkDeployStatusOnce, resolveDeployState, waitForDeployStatus } =
  await import("./status.ts");

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
  runVerification: <T>(_label: string, work: (controls: { update: () => void }) => Promise<T>) =>
    work({ update: () => {} }),
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

describe("checkDeployStatusOnce", () => {
  test("uses the DNS check response without polling status", async () => {
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue({
      status: "incomplete",
      dns: { status: "not_started" },
      ssl: { status: "complete", required: true },
      mail: { status: "complete", required: true },
      domain_id: "dmn_1",
      last_run_at: 1779739200000,
    });

    const outcome = await checkDeployStatusOnce("app_1", "dmn_1");

    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
    expect(mockGetApplicationDomainStatus).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      verified: false,
      status: { dns: false, ssl: true, mail: true },
    });
  });

  test("reads status once when a DNS check is already in flight", async () => {
    mockTriggerApplicationDomainDNSCheck.mockRejectedValue(
      new PlapiError(409, JSON.stringify({ errors: [{ code: "conflict" }] }), "https://x"),
    );
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const outcome = await checkDeployStatusOnce("app_1", "dmn_1");

    expect(mockGetApplicationDomainStatus).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      verified: true,
      status: { dns: true, ssl: true, mail: true },
    });
  });
});

describe("buildDeployStatusReport", () => {
  const activeSnapshot = {
    appId: "app_1",
    developmentInstanceId: "ins_dev",
    productionInstanceId: "ins_prod",
    productionDomainId: "dmn_1",
    domain: "example.com",
    oauthProviders: ["google", "github"],
    oauthProviderDescriptors: [],
    completedOAuthProviders: ["google"],
    cnameTargets: [
      { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
      { host: "clkmail.example.com", value: "mail.clerk.services", required: true },
    ],
    domainComplete: false,
    componentStatus: { dns: false, ssl: false, mail: false },
    unsupportedOAuthProviderCount: 0,
    unsupportedOAuthProviders: [],
    pending: { type: "oauth" as const, provider: "github" },
  } satisfies LiveDeploySnapshot;

  test("not_started reports incomplete with deploy next action", () => {
    const report = buildDeployStatusReport({ kind: "not_started" }, null);

    expect(report.complete).toBe(false);
    expect(report.state).toBe("not_started");
    expect(report.domain).toBeNull();
    expect(report.productionInstanceId).toBeNull();
    expect(report.domainStatus).toBeNull();
    expect(report.nextAction).toContain("clerk deploy");
  });

  test("domain_provisioning reports production instance", () => {
    const report = buildDeployStatusReport(
      { kind: "domain_provisioning", productionInstanceId: "ins_prod" },
      null,
    );

    expect(report.state).toBe("domain_provisioning");
    expect(report.complete).toBe(false);
    expect(report.productionInstanceId).toBe("ins_prod");
  });

  test("active with pending domain gives domain precedence over OAuth", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: false, ssl: true, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.complete).toBe(false);
    expect(report.domainStatus).toEqual({ dns: "pending", ssl: "complete", mail: "complete" });
    expect(report.pendingDnsRecords).toContainEqual({
      type: "CNAME",
      host: "clerk.example.com",
      value: "frontend-api.clerk.services",
    });
    expect(report.oauth.pending).toEqual(["github"]);
  });

  test("active with pending email DNS reports only email CNAME records", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: true, ssl: true, mail: false } },
    );

    expect(report.pendingDnsRecords).toEqual([
      {
        type: "CNAME",
        host: "clkmail.example.com",
        value: "mail.clerk.services",
      },
    ]);
  });

  test("active with complete domain but pending OAuth reports oauth_pending", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.state).toBe("oauth_pending");
    expect(report.complete).toBe(false);
    expect(report.oauth).toMatchObject({
      complete: false,
      configured: ["google"],
      pending: ["github"],
    });
  });

  test("active with complete domain and OAuth reports complete", () => {
    const allDone = {
      ...activeSnapshot,
      completedOAuthProviders: ["google", "github"],
    } satisfies LiveDeploySnapshot;
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: allDone },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.state).toBe("complete");
    expect(report.complete).toBe(true);
    expect(report.domainStatus).toEqual({ dns: "complete", ssl: "complete", mail: "complete" });
    expect(report.nextAction).toContain("https://example.com");
  });

  test("unsupported OAuth providers surface without blocking completion", () => {
    const withUnsupported = {
      ...activeSnapshot,
      completedOAuthProviders: ["google", "github"],
      unsupportedOAuthProviders: ["discord"],
      unsupportedOAuthProviderCount: 1,
    } satisfies LiveDeploySnapshot;
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: withUnsupported },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.complete).toBe(true);
    expect(report.oauth.unsupported).toEqual(["discord"]);
  });
});
