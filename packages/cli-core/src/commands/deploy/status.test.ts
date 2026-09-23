import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlapiError } from "../../lib/errors.ts";
import { captureTelemetryPayload } from "../../test/lib/stubs.ts";
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

const {
  agentNextAction,
  buildDeployStatusReport,
  buildInterruptedDeployStatusReport,
  deployNextStep,
  loadInitialDeployStatus,
  resolveDeployState,
  resolveLiveDeploySnapshot,
  waitForDeployStatus,
} = await import("./status.ts");
const { recordDeployObservation, recordDeployPoll } = await import("./telemetry.ts");
const { setTelemetryStage } = await import("../../lib/telemetry.ts");
const { _setConfigDir } = await import("../../lib/config.ts");
const { beginInterrupt, _resetInterruptState } = await import("../../lib/signals.ts");

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

    const observed: unknown[] = [];
    const outcome = await waitForDeployStatus("app_1", "dmn_1", "example.com", {
      ...passthroughHandlers,
      onStatus: (polled) => observed.push(polled),
    });

    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
    expect(mockTriggerApplicationDomainDNSCheck.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetApplicationDomainStatus.mock.invocationCallOrder[0]!,
    );
    expect(outcome).toEqual({
      verified: true,
      status: { dns: true, ssl: true, mail: true },
    });
    // The poll's own verdict travels with its components, so an observer can
    // tell "verified" from "all three passed but Clerk is still finalizing".
    expect(observed).toEqual([outcome]);
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

// The wizard's resume path substitutes "everything pending" for a failed read
// so the user can retry from the screen. The substitute is indistinguishable
// from a real all-pending answer by its fields, so the flag is the only thing
// that stops it being recorded as an observation.
describe("loadInitialDeployStatus", () => {
  test("a successful read is live", async () => {
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const result = await loadInitialDeployStatus("app_1", "dmn_1");

    expect(result.live).toBe(true);
    expect(result.status).toEqual(completeStatus as typeof result.status);
  });

  test("a failed read is substituted with everything pending, and is not live", async () => {
    mockGetApplicationDomainStatus.mockRejectedValue(
      new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
    );

    const result = await loadInitialDeployStatus("app_1", "dmn_1");

    expect(result.live).toBe(false);
    expect(result.status.status).toBe("incomplete");
    expect(result.status.dns?.status).toBe("not_started");
  });

  test("the read-only path throws instead of substituting", async () => {
    mockGetApplicationDomainStatus.mockRejectedValue(
      new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
    );

    await expect(
      loadInitialDeployStatus("app_1", "dmn_1", { throwOnStatusError: true }),
    ).rejects.toBeInstanceOf(PlapiError);
  });
});

// The only guard between a substituted "everything pending" read and a
// recorded DNS stall. The status command never trips it today because its
// read throws instead of substituting; the guard is here so that a change to
// that read cannot silently start recording fallbacks. Read back through the
// posted payload, since that is the only place the components are visible.
describe("recording observations", () => {
  const snapshot = {
    appId: "app_1",
    developmentInstanceId: "ins_dev",
    productionInstanceId: "ins_prod",
    productionDomainId: "dmn_1",
    domain: "example.com",
    oauthProviders: ["google"],
    oauthProviderDescriptors: [],
    completedOAuthProviders: ["google"],
    cnameTargets: [],
    domainComplete: false,
    live: true,
    componentStatus: { dns: false, ssl: true, mail: true },
    unsupportedOAuthProviderCount: 0,
    unsupportedOAuthProviders: [],
    pending: { type: "dns" as const },
  } satisfies LiveDeploySnapshot;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-status-observe-"));
    _setConfigDir(tempDir);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function recorded(run: () => void) {
    const { payload } = await captureTelemetryPayload("deploy status", run, {
      result: { outcome: "success", exitCode: 0 },
    });
    return { stage: payload.stage, components: payload.components };
  }

  test("a live snapshot records its state", async () => {
    const result = await recorded(() => recordDeployObservation({ kind: "active", snapshot }));

    expect(result.stage).toBe("domain_pending");
  });

  test("a poll records the domain group and the stage, and leaves OAuth alone", async () => {
    const result = await recorded(() =>
      recordDeployPoll(snapshot, { verified: true, status: { dns: true, ssl: true, mail: true } }),
    );

    expect(result).toEqual({
      stage: "complete",
      components: { dns: true, ssl: true, mail: true, oauth: null },
    });
  });

  test("a substituted snapshot records no stage; its components were the read's to record", async () => {
    const result = await recorded(() => {
      setTelemetryStage("oauth_pending");
      recordDeployObservation({ kind: "active", snapshot: { ...snapshot, live: false } });
    });

    expect(result).toEqual({
      stage: "oauth_pending",
      components: { dns: null, ssl: null, mail: null, oauth: null },
    });
  });

  test("the two states without a snapshot record a stage and no components", async () => {
    const notStarted = await recorded(() => recordDeployObservation({ kind: "not_started" }));
    expect(notStarted).toEqual({
      stage: "not_started",
      components: { dns: null, ssl: null, mail: null, oauth: null },
    });

    const provisioning = await recorded(() =>
      recordDeployObservation({
        kind: "domain_provisioning",
        appId: "app_1",
        productionInstanceId: "ins_prod",
      }),
    );
    expect(provisioning.stage).toBe("domain_provisioning");
    expect(provisioning.components).toEqual({ dns: null, ssl: null, mail: null, oauth: null });
  });
});

// Production configuration and domain status are read together, and each is
// recorded the moment it succeeds: a failure in one must not discard what the
// other observed, and the recording must not race the telemetry send.
describe("resolveLiveDeploySnapshot records each read as it succeeds", () => {
  const serverError = () =>
    new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x");
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-status-reads-"));
    _setConfigDir(tempDir);
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
          cname_targets: [],
        },
      ],
      total_count: 1,
    });
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
  });

  afterEach(async () => {
    _resetInterruptState();
    _setConfigDir(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Development enabled Google; production has credentials, or the read fails. */
  function mockConfigReads(production: Record<string, unknown> | Error) {
    mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) => {
      if (instanceId !== "ins_prod") return { connection_oauth_google: { enabled: true } };
      return production instanceof Error ? Promise.reject(production) : production;
    });
  }

  const configured = {
    connection_oauth_google: { enabled: true, client_id: "id", client_secret: "s" },
  };

  async function resolved(options: { throwOnStatusError?: boolean } = {}) {
    return captureTelemetryPayload(
      "deploy status",
      async () => {
        await resolveLiveDeploySnapshot({ ...ctx, productionInstanceId: "ins_prod" }, options);
      },
      { captureError: true },
    );
  }

  test("a failed configuration read keeps what the domain read observed", async () => {
    mockConfigReads(serverError());
    mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);

    const { payload, error } = await resolved();

    expect(error).toBeInstanceOf(PlapiError);
    expect(payload.components).toEqual({ dns: true, ssl: true, mail: true, oauth: null });
    expect(payload.stage).toBeNull();
  });

  test("on the strict path a failed domain read keeps what the configuration read observed", async () => {
    mockConfigReads(configured);
    mockGetApplicationDomainStatus.mockRejectedValue(serverError());

    const { payload, error } = await resolved({ throwOnStatusError: true });

    expect(error).toBeInstanceOf(PlapiError);
    expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: true });
    expect(payload.stage).toBeNull();
  });

  test("on the lenient path a failed domain read substitutes and records OAuth alone", async () => {
    mockConfigReads(configured);
    mockGetApplicationDomainStatus.mockRejectedValue(serverError());

    const { payload, error } = await resolved();

    expect(error).toBeUndefined();
    expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: true });
  });

  test("a read that completed before an interrupt is kept", async () => {
    mockConfigReads(configured);
    mockGetApplicationDomainStatus.mockImplementation(() => {
      beginInterrupt();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const { payload, error } = await resolved({ throwOnStatusError: true });

    expect(error).toBeInstanceOf(DOMException);
    expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: true });
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
    live: true,
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

describe("report urls", () => {
  const snapshot = {
    appId: "app_1",
    developmentInstanceId: "ins_dev",
    productionInstanceId: "ins_prod",
    productionDomainId: "dmn_1",
    domain: "example.com",
    oauthProviders: [],
    oauthProviderDescriptors: [],
    completedOAuthProviders: [],
    cnameTargets: [],
    domainComplete: false,
    live: true,
    componentStatus: { dns: false, ssl: false, mail: false },
    unsupportedOAuthProviderCount: 0,
    unsupportedOAuthProviders: [],
    pending: undefined,
  } satisfies LiveDeploySnapshot;

  test("carries the instance and Domains page URLs once a production instance exists", () => {
    // Agents used to have to pull the URL out of the `nextAction` prose.
    const report = buildDeployStatusReport({ kind: "active", snapshot }, null);
    expect(report.urls).toEqual({
      instance: "https://dashboard.clerk.com/apps/app_1/instances/ins_prod",
      domains: "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
    });
    expect(
      buildDeployStatusReport(
        { kind: "domain_provisioning", appId: "app_1", productionInstanceId: "ins_prod" },
        null,
      ).urls,
    ).toEqual(report.urls);
  });

  test("is null when there is no production instance to point at", () => {
    expect(buildDeployStatusReport({ kind: "not_started" }, null).urls).toBeNull();
    expect(buildInterruptedDeployStatusReport().urls).toBeNull();
    expect(
      buildDeployStatusReport(
        { kind: "active", snapshot: { ...snapshot, productionInstanceId: undefined } },
        null,
      ).urls,
    ).toBeNull();
  });
});

describe("deployNextStep", () => {
  // The step is derived from the report's own fields, so a report and the
  // sentence stored in it can't describe different situations.
  const base = {
    complete: false,
    state: "domain_pending" as const,
    domain: "example.com",
    productionInstanceId: "ins_prod",
    domainStatus: { dns: "pending", ssl: "pending", mail: "pending" } as const,
    pendingDnsRecords: [
      { type: "CNAME" as const, host: "clerk.example.com", value: "v", required: true },
    ],
    oauth: { complete: true, configured: [], pending: [], unsupported: [] },
    urls: {
      domains: "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
      instance: "https://dashboard.clerk.com/apps/app_1/instances/ins_prod",
    },
  };

  test.each([
    {
      label: "records to add",
      domainStatus: { dns: "pending", ssl: "pending", mail: "pending" } as const,
      records: 1,
      kind: "records_available",
      phrase: "DNS and email DNS",
    },
    {
      label: "records missing from the report",
      domainStatus: { dns: "pending", ssl: "pending", mail: "complete" } as const,
      records: 0,
      kind: "records_unavailable",
      phrase: "DNS",
    },
    {
      label: "only SSL pending",
      domainStatus: { dns: "complete", ssl: "pending", mail: "complete" } as const,
      records: 0,
      kind: "ssl_pending",
      phrase: "",
    },
    {
      label: "everything verified, Clerk finalizing",
      domainStatus: { dns: "complete", ssl: "complete", mail: "complete" } as const,
      records: 0,
      kind: "finalizing",
      phrase: "",
    },
  ])("classifies a pending domain: $label", ({ domainStatus, records, kind, phrase }) => {
    const step = deployNextStep({
      ...base,
      domainStatus,
      pendingDnsRecords: base.pendingDnsRecords.slice(0, records),
    });
    expect(step.kind).toBe(kind);
    if (step.kind === "records_available" || step.kind === "records_unavailable") {
      expect(step.records).toBe(phrase);
      expect(step.domainsUrl).toBe(base.urls.domains);
    }
  });

  test("the agent sentence is rendered from the step the report classifies", () => {
    const report = buildDeployStatusReport({ kind: "not_started" }, null);
    expect(report.nextAction).toBe(agentNextAction(deployNextStep(report)));
  });
});
