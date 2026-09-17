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

const { buildDeployStatusReport, resolveDeployState, waitForDeployStatus } =
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
      appId: "app_1",
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
      { kind: "domain_provisioning", appId: "app_1", productionInstanceId: "ins_prod" },
      null,
    );

    expect(report.state).toBe("domain_provisioning");
    expect(report.complete).toBe(false);
    expect(report.productionInstanceId).toBe("ins_prod");
    expect(report.nextAction).toContain(
      "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
    );
  });

  test("active with pending domain gives domain precedence over OAuth", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: false, ssl: true, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.complete).toBe(false);
    expect(report.nextAction).toContain(
      "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
    );
    expect(report.nextAction).toContain("Ask the user to visit");
    expect(report.nextAction).toContain("offer to open it");
    expect(report.domainStatus).toEqual({ dns: "pending", ssl: "complete", mail: "complete" });
    expect(report.pendingDnsRecords).toContainEqual({
      type: "CNAME",
      host: "clerk.example.com",
      value: "frontend-api.clerk.services",
      required: true,
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
        required: true,
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
    expect(report.nextAction).toContain("missing production credentials: github");
    // The domain is verified, so there is nothing to monitor on the Domains page.
    expect(report.nextAction).not.toContain("/domains");
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
    // Nothing left to monitor on the Domains page once complete; the pointer
    // is the instance root, where users, settings, and billing live.
    expect(report.nextAction).toContain(
      "Manage users, settings, and billing for this instance: https://dashboard.clerk.com/apps/app_1/instances/ins_prod",
    );
    expect(report.nextAction).not.toContain("/domains");
    expect(report.nextAction).not.toContain("Ask the user to visit");
  });

  test("complete next action says the keys still have to reach the host", () => {
    // Complete on Clerk's side only: the app runs on development keys until
    // the production keys are set on the host, and the report can't tell
    // whether that happened — so "if you haven't already", never "no action".
    const allDone = {
      ...activeSnapshot,
      completedOAuthProviders: ["google", "github"],
    } satisfies LiveDeploySnapshot;
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: allDone },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.nextAction).toContain(
      "Clerk's production setup for https://example.com is verified. If you haven't already:",
    );
    expect(report.nextAction).toContain("clerk env pull --instance prod");
    expect(report.nextAction).toContain("alongside the other Clerk variables from your env file");
    expect(report.nextAction).toContain("sign up at https://example.com to confirm");
    expect(report.nextAction).not.toContain("No action needed");
  });

  test("pending DNS records tell the agent to add them, not to keep polling", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: false, ssl: false, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.nextAction).toContain("DNS records not found yet for example.com.");
    expect(report.nextAction).toContain("Add the records in `pendingDnsRecords`");
    expect(report.nextAction).toContain("re-run `clerk deploy status --wait`");
    expect(report.nextAction).not.toContain("still provisioning");
  });

  test("pending email DNS records are named on their own when the Frontend API is verified", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: true, ssl: true, mail: false } },
    );

    expect(report.nextAction).toContain("Email DNS records not found yet for example.com.");
    expect(report.nextAction).not.toContain("email DNS records not found");
    expect(report.nextAction).not.toContain("DNS and email DNS");
  });

  test("SSL-only pending keeps the wait instruction, since there is nothing to add", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: true, ssl: false, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.nextAction).toContain(
      "SSL certificate still pending for example.com. Clerk issues it automatically now that DNS is verified; re-run `clerk deploy status` in a few minutes.",
    );
    expect(report.nextAction).not.toContain("not found yet");
    // DNS is verified in this state, so the old "DNS propagation can take
    // time" clause would be wrong here.
    expect(report.nextAction).not.toContain("DNS propagation");
  });

  test("pending DNS with no record list says so instead of pointing at an empty array", () => {
    // cname_targets is optional on the API's domain object. When it's absent,
    // "add the records in pendingDnsRecords" would send the agent to [].
    const noTargets = { ...activeSnapshot, cnameTargets: [] } satisfies LiveDeploySnapshot;
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: noTargets },
      { verified: false, status: { dns: false, ssl: false, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.pendingDnsRecords).toEqual([]);
    expect(report.nextAction).toContain(
      "DNS records not found yet for example.com, but this report has no record list.",
    );
    expect(report.nextAction).toContain("Find the records to add on the Domains page");
    expect(report.nextAction).toContain("re-run `clerk deploy status --wait`");
    expect(report.nextAction).not.toContain("Add the records in `pendingDnsRecords`");
    expect(report.nextAction).not.toContain("still provisioning");
    // The Dashboard URL appears once, via the shared trailing clause.
    expect(report.nextAction.match(/\/domains/g)).toHaveLength(1);
  });

  test("all components verified but not yet complete says Clerk is still finalizing", () => {
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: activeSnapshot },
      { verified: false, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.state).toBe("domain_pending");
    expect(report.pendingDnsRecords).toEqual([]);
    expect(report.nextAction).toContain(
      "Production setup for example.com is still finalizing on Clerk's side.",
    );
    expect(report.nextAction).not.toContain("not found yet");
    expect(report.nextAction).not.toContain("SSL");
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

  test.each<{ label: string; completed: string[] }>([
    { label: "complete", completed: ["google", "github"] },
    { label: "oauth_pending", completed: ["google"] },
  ])(
    "names providers the CLI could not configure so the agent does not call OAuth done ($label)",
    ({ completed }) => {
      // In development Clerk supplies shared OAuth credentials; in production
      // it doesn't. A provider the CLI skipped has a sign-in button that fails
      // for real users, and `oauth.complete` only covers what the CLI manages.
      const withUnsupported = {
        ...activeSnapshot,
        completedOAuthProviders: completed,
        unsupportedOAuthProviders: ["discord"],
        unsupportedOAuthProviderCount: 1,
      } satisfies LiveDeploySnapshot;
      const report = buildDeployStatusReport(
        { kind: "active", snapshot: withUnsupported },
        { verified: true, status: { dns: true, ssl: true, mail: true } },
      );

      expect(report.nextAction).toContain(
        "These providers are enabled in development but the CLI could not configure them for production: discord.",
      );
      expect(report.nextAction).toContain("users signing in with them will fail");
    },
  );

  test("does not mention unsupported providers when there are none", () => {
    const report = buildDeployStatusReport(
      {
        kind: "active",
        snapshot: { ...activeSnapshot, completedOAuthProviders: ["google", "github"] },
      },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.nextAction).not.toContain("could not configure");
  });

  test.each([
    { label: "complete", verified: true, status: { dns: true, ssl: true, mail: true } },
    { label: "records pending", verified: false, status: { dns: false, ssl: false, mail: false } },
    { label: "SSL pending", verified: false, status: { dns: true, ssl: false, mail: true } },
  ])(
    "omits Dashboard links cleanly when the production instance id is unknown ($label)",
    ({ verified, status }) => {
      const noInstance = {
        ...activeSnapshot,
        productionInstanceId: undefined,
        completedOAuthProviders: ["google", "github"],
      } satisfies LiveDeploySnapshot;
      const report = buildDeployStatusReport(
        { kind: "active", snapshot: noInstance },
        { verified, status },
      );

      expect(report.productionInstanceId).toBeNull();
      expect(report.nextAction).not.toContain("dashboard.clerk.com");
      expect(report.nextAction).not.toContain("undefined");
      expect(report.nextAction).not.toContain("Clerk Dashboard domains page");
    },
  );
});
