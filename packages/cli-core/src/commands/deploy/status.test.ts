import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlapiError } from "../../lib/errors.ts";
import { captureTelemetryPayload } from "../../test/lib/stubs.ts";
import type { LiveDeploySnapshot } from "./status.ts";

const mockFetchApplication = mock();
const mockListApplicationDomains = mock();
const mockListIOSApplications = mock();
const mockGetNativeSettings = mock();
const mockFetchInstanceConfig = mock();
const mockFetchInstanceConfigSchema = mock();
const mockGetApplicationDomainStatus = mock();
const mockTriggerApplicationDomainDNSCheck = mock();

mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  listApplicationDomains: (...args: unknown[]) => mockListApplicationDomains(...args),
  listIOSApplications: (...args: unknown[]) => mockListIOSApplications(...args),
  getNativeSettings: (...args: unknown[]) => mockGetNativeSettings(...args),
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

const appleOAuthSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    authenticatable: { type: "boolean" },
    client_id: { type: "string" },
    client_secret: { type: "string", "x-clerk-sensitive": true },
    team_id: { type: "string" },
    key_id: { type: "string" },
    bundle_id: { type: "string" },
  },
};

function mockActiveProductionEnvironment(): void {
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
        cname_targets: [],
      },
    ],
    total_count: 1,
  });
  mockFetchInstanceConfigSchema.mockResolvedValue({
    properties: { connection_oauth_apple: appleOAuthSchema },
  });
  mockGetApplicationDomainStatus.mockResolvedValue(completeStatus);
}

beforeEach(() => {
  mockFetchInstanceConfig.mockResolvedValue({});
  mockFetchInstanceConfigSchema.mockResolvedValue({ properties: {} });
  mockListIOSApplications.mockResolvedValue([]);
  mockGetNativeSettings.mockResolvedValue({ object: "native_settings", api_enabled: true });
});

afterEach(() => {
  mockFetchApplication.mockReset();
  mockListApplicationDomains.mockReset();
  mockListIOSApplications.mockReset();
  mockGetNativeSettings.mockReset();
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

  describe("native-only Apple", () => {
    const nativeConnection = {
      enabled: true,
      authenticatable: true,
      bundle_id: "com.example.native",
    };
    const registration = {
      object: "ios_application",
      id: "ios_native",
      app_id_prefix: "ABCDE12345",
      bundle_id: "com.example.native",
    };

    function mockProductionApple(
      connection: Record<string, unknown>,
      development: Record<string, unknown> = { enabled: true },
    ): void {
      mockActiveProductionEnvironment();
      mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) =>
        instanceId === "ins_prod"
          ? { connection_oauth_apple: connection }
          : { connection_oauth_apple: development },
      );
    }

    test("is complete with an exact production registration", async () => {
      mockProductionApple(nativeConnection);
      mockListIOSApplications.mockResolvedValue([registration]);

      const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.snapshot.completedOAuthProviders).toEqual(["apple"]);
        expect(state.snapshot.nativeAppleReadinessIssue).toBeUndefined();
        expect(buildDeployStatusReport(state, null).complete).toBe(true);
      }
      expect(mockListIOSApplications).toHaveBeenCalledWith("app_1", "ins_prod");
      expect(mockGetNativeSettings).toHaveBeenCalledWith("app_1", "ins_prod");
    });

    test("points a missing registration at the production Native Applications page", async () => {
      mockProductionApple(nativeConnection);
      mockListIOSApplications.mockResolvedValue([
        { ...registration, bundle_id: "com.example.other" },
      ]);

      const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.snapshot.pending).toEqual({ type: "oauth", provider: "apple" });
        expect(state.snapshot.nativeAppleReadinessIssue).toEqual({
          bundleId: "com.example.native",
          reason: "registration-missing",
          dashboardUrl:
            "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/native-applications",
        });
        const report = buildDeployStatusReport(state, null);
        expect(report.state).toBe("oauth_pending");
        expect(report.nextAction).toContain(
          "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/native-applications",
        );
        expect(report.nextAction).not.toContain("missing production credentials: apple");
      }
    });

    test("keeps development's native-only intent when production was cloned without a Bundle ID", async () => {
      // Creating production clones Apple without its provider settings.
      mockProductionApple({ enabled: true, authenticatable: true }, nativeConnection);

      const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.snapshot.pending).toEqual({ type: "oauth", provider: "apple" });
        expect(state.snapshot.nativeAppleReadinessIssue).toMatchObject({
          bundleId: "com.example.native",
          reason: "bundle-id-missing",
        });
        const report = buildDeployStatusReport(state, null);
        expect(report.nextAction).toContain("has no Bundle ID");
        expect(report.nextAction).not.toContain("missing production credentials: apple");
      }
      expect(mockListIOSApplications).not.toHaveBeenCalled();
    });

    // `oauth.setup` asks for web credentials (Services ID, .p8 key), which
    // native-only Apple doesn't use; an entry there would bury the Bundle ID
    // fix the readiness issue carries.
    test("leaves native-only Apple out of oauth.setup", async () => {
      mockProductionApple({ enabled: true, authenticatable: true }, nativeConnection);

      const report = buildDeployStatusReport(
        await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" }),
        null,
      );

      expect(report.state).toBe("oauth_pending");
      // Still pending: the readiness issue is what's missing.
      expect(report.oauth.pending).toEqual(["apple"]);
      expect(report.oauth.setup).toEqual([]);
      expect(report.nativeAppleReadinessIssue?.reason).toBe("bundle-id-missing");
      expect(report.nextAction).toContain("has no Bundle ID");
      expect(report.nextAction).not.toContain("oauth.setup");
    });

    // A Bundle ID with no web credentials reads as native-only, but the app may
    // also offer Apple sign-in on the web, which development serves with
    // Clerk's shared credentials. #509's wizard asks; the report says it.
    test("says web Sign in with Apple still needs web credentials", async () => {
      mockProductionApple({ enabled: true, authenticatable: true }, nativeConnection);

      const report = buildDeployStatusReport(
        await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" }),
        null,
      );

      expect(report.nextAction).toContain(
        "If the app also offers Sign in with Apple on the web, production needs Apple web " +
          "credentials too; the user can add them with `clerk deploy` in a terminal.",
      );
    });

    test("leaves native-only Apple out of oauth.setup while the domain is pending", async () => {
      mockProductionApple({ enabled: true, authenticatable: true }, nativeConnection);
      mockGetApplicationDomainStatus.mockResolvedValue({
        status: "incomplete",
        dns: { status: "not_started" },
        ssl: { status: "not_started", required: true },
        mail: { status: "not_started", required: true },
      });

      const report = buildDeployStatusReport(
        await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" }),
        null,
      );

      expect(report.state).toBe("domain_pending");
      expect(report.oauth.setup).toEqual([]);
      expect(report.nextAction).toContain("has no Bundle ID");
    });

    test("sends a pending Google to oauth.setup next to the native Apple guidance", async () => {
      mockProductionApple({ enabled: true, authenticatable: true }, nativeConnection);
      mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) => ({
        connection_oauth_apple:
          instanceId === "ins_prod" ? { enabled: true, authenticatable: true } : nativeConnection,
        connection_oauth_google: { enabled: true },
      }));
      mockFetchInstanceConfigSchema.mockResolvedValue({
        properties: {
          connection_oauth_apple: appleOAuthSchema,
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

      const report = buildDeployStatusReport(
        await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" }),
        null,
      );

      expect(report.state).toBe("oauth_pending");
      expect(report.oauth.pending).toEqual(["apple", "google"]);
      expect(report.oauth.setup.map((entry) => entry.provider)).toEqual(["google"]);
      expect(report.nextAction).toContain("has no Bundle ID");
      expect(report.nextAction).toContain("also missing production credentials: google");
      expect(report.nextAction).toContain("For each entry in `oauth.setup`");
      // The wizard would ask for Apple web credentials first.
      expect(report.nextAction).not.toContain("in a terminal to enter them interactively");
    });

    test("reports unverifiable rather than missing when native reads fail", async () => {
      mockProductionApple(nativeConnection);
      mockListIOSApplications.mockRejectedValue(new Error("native endpoint unavailable"));

      const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.snapshot.nativeAppleReadinessIssue?.reason).toBe("verification-unavailable");
        expect(buildDeployStatusReport(state, null).nextAction).toContain(
          "don't create another registration",
        );
      }
    });

    test("leaves hosted Apple credential-based without native reads", async () => {
      mockProductionApple(
        {
          enabled: true,
          bundle_id: "com.example.native",
          client_id: "com.example.web",
          client_secret: "REDACTED",
          team_id: "TEAM123456",
          key_id: "KEY1234567",
        },
        nativeConnection,
      );

      const state = await resolveDeployState({ ...ctx, productionInstanceId: "ins_prod" });

      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.snapshot.completedOAuthProviders).toEqual(["apple"]);
        expect(state.snapshot.nativeAppleReadinessIssue).toBeUndefined();
      }
      expect(mockListIOSApplications).not.toHaveBeenCalled();
    });
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
// recorded the moment it succeeds, so a failure in one does not discard what
// the other observed. The reads fail fast: a read that finishes only after
// the event is built is dropped, never misrecorded. These mocks settle
// immediately, so the recording lands before the send — a tripwire for that
// ordering, not a guarantee the code makes.
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

  test("records verified native Apple registration as OAuth complete without web credentials", async () => {
    mockActiveProductionEnvironment();
    mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) => ({
      connection_oauth_apple: {
        enabled: true,
        authenticatable: true,
        ...(instanceId === "ins_prod" && { bundle_id: "com.example.native" }),
      },
    }));
    mockListIOSApplications.mockResolvedValue([
      {
        object: "ios_application",
        id: "ios_native",
        app_id_prefix: "ABCDE12345",
        bundle_id: "com.example.native",
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const { payload, error } = await resolved();

    expect(error).toBeUndefined();
    expect(payload.components).toEqual({ dns: true, ssl: true, mail: true, oauth: true });
  });

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
    // Creating is hard to undo and the domain is the user's to pick, so asking
    // comes before the command.
    expect(report.nextAction).toContain("Ask the user which domain they own");
    expect(report.nextAction).toContain("clerk deploy --domain <domain>");
    expect(report.nextAction).not.toContain("human terminal");
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

  test("oauth_pending hands over what each pending provider needs", () => {
    const apple = {
      provider: "apple",
      configKey: "connection_oauth_apple",
      label: "Apple",
      docsUrl: "https://clerk.com/docs/apple",
      credentialLabel: "",
      redirectLabel: "Return URL",
      setupCopy: "",
      gotcha: "Save the .p8 file.",
      fields: [
        {
          key: "client_id",
          label: "Apple Services ID",
          type: "text",
          secret: false,
          filePath: false,
        },
        {
          key: "client_secret",
          // The wizard's prompt asks for a path; the config field takes the key itself.
          label: "Apple Private Key - path to .p8 file",
          description: "Apple Private Key",
          type: "password",
          secret: true,
          filePath: true,
        },
        {
          key: "actor",
          label: "Actor",
          type: "select",
          options: ["user", "application"],
          secret: false,
          filePath: false,
        },
      ],
      requiredCredentialKeys: ["client_id", "client_secret"],
      credentialSources: ["manual"],
    } satisfies LiveDeploySnapshot["oauthProviderDescriptors"][number];
    const report = buildDeployStatusReport(
      {
        kind: "active",
        snapshot: {
          ...activeSnapshot,
          frontendApiUrl: "https://clerk.example.com",
          oauthProviders: ["google", "apple"],
          // A configured provider gets no entry even though it has a descriptor.
          oauthProviderDescriptors: [{ ...apple, provider: "google" }, apple],
          completedOAuthProviders: ["google"],
        },
      },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.oauth.setup).toEqual([
      {
        provider: "apple",
        label: "Apple",
        configKey: "connection_oauth_apple",
        fields: [
          { key: "client_id", label: "Apple Services ID", required: true, secret: false },
          {
            key: "client_secret",
            label: "Apple Private Key",
            required: true,
            secret: true,
            fileContents: true,
          },
          {
            key: "actor",
            label: "Actor",
            required: false,
            secret: false,
            options: ["user", "application"],
          },
        ],
        authorizedOrigins: ["https://example.com", "https://www.example.com"],
        redirectUri: "https://clerk.example.com/v1/oauth_callback",
        docsUrl: "https://clerk.com/docs/apple",
        note: "Save the .p8 file.",
        // Required fields only: a placeholder for an optional one would be
        // sent as its value.
        payload: {
          connection_oauth_apple: {
            enabled: true,
            client_id: "<client_id>",
            client_secret: "<client_secret>",
          },
        },
        // A file, not `--json`: secrets on a command line end up in process
        // listings. The id, not `prod`: that alias needs the local profile.
        command: "clerk config patch --instance ins_prod --file <file> --yes",
      },
    ]);
    expect(report.nextAction).toContain("For each entry in `oauth.setup`");
  });

  // A client secret pasted into chat ends up in the agent's transcript, so the
  // person types the values into the file and the agent never reads them.
  describe("who fills in OAuth credentials", () => {
    const descriptor = (
      provider: string,
      label: string,
      fileField: boolean,
    ): LiveDeploySnapshot["oauthProviderDescriptors"][number] => ({
      provider,
      configKey: `connection_oauth_${provider}`,
      label,
      docsUrl: "",
      credentialLabel: "",
      redirectLabel: "",
      setupCopy: "",
      gotcha: null,
      fields: [
        { key: "client_id", label: "Client ID", type: "text", secret: false, filePath: false },
        {
          key: "client_secret",
          label: fileField ? "Private key - path to .p8 file" : "Client secret",
          type: "password",
          secret: true,
          filePath: fileField,
        },
      ],
      requiredCredentialKeys: ["client_id", "client_secret"],
      credentialSources: ["manual"],
    });
    const oauthPendingReport = (
      descriptors: LiveDeploySnapshot["oauthProviderDescriptors"],
    ): ReturnType<typeof buildDeployStatusReport> =>
      buildDeployStatusReport(
        {
          kind: "active",
          snapshot: {
            ...activeSnapshot,
            oauthProviders: descriptors.map((entry) => entry.provider),
            oauthProviderDescriptors: descriptors,
            completedOAuthProviders: [],
          },
        },
        { verified: true, status: { dns: true, ssl: true, mail: true } },
      );

    test("the agent writes the placeholders and the user replaces them", () => {
      const report = oauthPendingReport([descriptor("github", "GitHub", false)]);

      expect(report.state).toBe("oauth_pending");
      expect(report.nextAction).toContain(
        "Write its `payload` to a temporary JSON file as it is, placeholders included, " +
          "and ask the user to replace each `<placeholder>` with the real value. " +
          "Don't ask for the values or read the file.",
      );
      expect(report.nextAction).not.toContain("with the real values to a JSON file");
      expect(report.nextAction).not.toContain("in a terminal first");
    });

    test("an entry holding a file's contents sends the user to the wizard first", () => {
      const report = oauthPendingReport([
        descriptor("github", "GitHub", false),
        descriptor("apple", "Apple", true),
      ]);

      expect(report.nextAction).toContain(
        "Apple's entry takes a file's contents (a private key), which is easy to break when pasted " +
          "into JSON. Save the other `oauth.setup` entries first, then send the user to " +
          "`clerk deploy` in a terminal for Apple: the wizard reads the key from its file.",
      );
    });
  });

  test("setup entries are there while the domain is still pending", () => {
    const report = buildDeployStatusReport(
      {
        kind: "active",
        snapshot: {
          ...activeSnapshot,
          oauthProviderDescriptors: [
            {
              provider: "github",
              configKey: "connection_oauth_github",
              label: "GitHub",
              docsUrl: "",
              credentialLabel: "",
              redirectLabel: "",
              setupCopy: "",
              gotcha: null,
              fields: [],
              requiredCredentialKeys: [],
              credentialSources: ["manual"],
            },
          ],
        },
      },
      null,
    );

    expect(report.state).toBe("domain_pending");
    expect(report.oauth.setup.map((entry) => entry.provider)).toEqual(["github"]);
  });

  test("a report with nothing pending has no setup entries", () => {
    expect(buildDeployStatusReport({ kind: "not_started" }, null).oauth.setup).toEqual([]);
    expect(buildInterruptedDeployStatusReport().oauth.setup).toEqual([]);
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
    // A bare `env pull` would write the production keys over the local
    // development ones.
    expect(report.nextAction).toContain("clerk env pull --instance ins_prod --print");
    expect(report.nextAction).toContain("alongside the other Clerk variables from your env file");
    expect(report.nextAction).toContain("sign up at https://example.com to confirm");
    expect(report.nextAction).not.toContain("No action needed");
  });

  test("complete next action moves the keys to the host without the agent reading them", () => {
    // The secret key ends up in the agent's transcript if it reads `--print`
    // output, so the sentence hands it a pipe that never shows the values.
    const allDone = {
      ...activeSnapshot,
      completedOAuthProviders: ["google", "github"],
    } satisfies LiveDeploySnapshot;
    const report = buildDeployStatusReport(
      { kind: "active", snapshot: allDone },
      { verified: true, status: { dns: true, ssl: true, mail: true } },
    );

    expect(report.nextAction).toContain("put the production keys on the host without reading them");
    expect(report.nextAction).toContain(
      "`( allow_shared=0; set -o pipefail; keys=$(clerk env pull --instance ins_prod --print) || exit 1; ",
    );
    expect(report.nextAction).toContain("FORCE_COLOR=0 vercel env ls --no-color");
    // Whether `--force` on production rewrites a variable Vercel shares with
    // preview and development is unverified, so a shared one needs a person,
    // and the consent stays in the one command they approved.
    expect(report.nextAction).toContain(
      "If a key is already set as a production variable that also targets another environment " +
        "(Preview, Development, or a custom one), it stops with exit 3 and names it: ask the user " +
        "before replacing it, because `--force` may rewrite that shared variable and put the " +
        "production secret key in those deployments. " +
        "If they agree, run the command again with its leading `allow_shared=0` changed to " +
        "`allow_shared=1`.",
    );
    expect(report.nextAction).toContain("it stops with exit 1 if it can't read that list");
    expect(report.nextAction).not.toContain("export");
    expect(report.nextAction).toContain("redeploy only after it exits 0");
    // A host without a CLI needs a person to paste the values, not the agent.
    expect(report.nextAction).toContain(
      "For a host without a CLI, ask the user to run `clerk env pull --instance ins_prod --print`",
    );
  });

  // The command an agent copies from the `complete` report, run as written in
  // the shells agents use, against stub `clerk` and `vercel` commands. Its exit
  // status is what tells the agent whether it may redeploy, so every failure
  // has to show up there, and no key may reach the agent's output. The
  // `vercel env ls` output follows Vercel's own formatting (env/ls.ts).
  describe.each(["bash", "zsh"])("the key-copying command in %s", (shell) => {
    const installed = Bun.which(shell) !== null;
    const stubs = `
clerk() {
  case "$SCENARIO" in
    pull_fails) echo "error: not signed in" >&2; return 1 ;;
    pull_prints_then_fails) printf '%s\n' 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_FAKE'; return 1 ;;
    *) printf '%s\n' 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_FAKE' 'CLERK_SECRET_KEY=sk_live_FAKE=with=equals' ;;
  esac
}
vercel() {
  if [ "$1 $2" = "env ls" ]; then
    echo "FORCE_COLOR=$FORCE_COLOR $*" >> "$RECEIVED.ls"
    case "$SCENARIO" in
      ls_fails) echo "Error: no linked project" >&2; return 1 ;;
      unrecognized) echo "Vercel CLI 99.0.0"; echo "Something we have never seen" ;;
      none) echo "> No Environment Variables found for team/project [120ms]" >&2 ;;
      *)
        echo "> Environment Variables found for team/project [120ms]" >&2
        echo ""
        echo " name                value      type       environments                        created"
        case "$SCENARIO" in
          unrelated) echo " OTHER_VAR           Encrypted  Sensitive  Production, Preview, Development    1d ago" ;;
          production_only) echo " CLERK_SECRET_KEY    Encrypted  Sensitive  Production                          1d ago" ;;
          preview_dev_only) echo " CLERK_SECRET_KEY    Encrypted  Sensitive  Preview, Development                1d ago" ;;
          shared) echo " CLERK_SECRET_KEY    Encrypted  Sensitive  Production, Preview, Development    1d ago" ;;
          custom_env) echo " CLERK_SECRET_KEY    Encrypted  Sensitive  Production, staging                 1d ago" ;;
          large)
            i=0
            while [ $i -lt 1000 ]; do
              echo " OTHER_VAR_$i    Encrypted  Sensitive  Production, Preview, Development    1d ago"
              i=$((i + 1))
            done
            ;;
          colored_shared) printf ' \\033[1mCLERK_SECRET_KEY\\033[22m    \\033[90mEncrypted\\033[39m  Sensitive  \\033[1mProduction\\033[22m, \\033[1mPreview\\033[22m, \\033[1mDevelopment\\033[22m    1d ago\\n' ;;
        esac
        ;;
    esac
    return 0
  fi
  value=$(cat)
  if [ "$SCENARIO" = first_upload_fails ] && [ "$3" = NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ]; then
    echo "Error: upload failed" >&2
    return 1
  fi
  printf '%s|%s\n' "$*" "$value" >> "$RECEIVED"
}
`;

    function keyCopyCommand(): string {
      const report = buildDeployStatusReport(
        {
          kind: "active",
          snapshot: { ...activeSnapshot, completedOAuthProviders: ["google", "github"] },
        },
        { verified: true, status: { dns: true, ssl: true, mail: true } },
      );
      const match = /For Vercel[^`]*`([^`]+)`/.exec(report.nextAction);
      if (!match) throw new Error(`No key-copying command in: ${report.nextAction}`);
      return match[1]!;
    }

    async function run(
      scenario: string,
      options: { command?: string; env?: Record<string, string> } = {},
    ): Promise<{ exitCode: number; output: string; uploads: string[]; listings: string[] }> {
      const dir = await mkdtemp(join(tmpdir(), "clerk-key-copy-"));
      const received = join(dir, "received");
      const lines = async (path: string): Promise<string[]> => {
        const file = Bun.file(path);
        return (await file.exists()) ? (await file.text()).trim().split("\n") : [];
      };
      try {
        // `-f` keeps zsh from reading the developer's startup files.
        const args = shell === "zsh" ? ["zsh", "-f", "-c"] : ["bash", "-c"];
        const proc = Bun.spawn([...args, `${stubs}\n${options.command ?? keyCopyCommand()}`], {
          env: {
            PATH: process.env.PATH ?? "",
            SCENARIO: scenario,
            RECEIVED: received,
            ...options.env,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return {
          exitCode,
          output: stdout + stderr,
          uploads: await lines(received),
          listings: await lines(`${received}.ls`),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    const bothUploaded = [
      "env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --force|pk_live_FAKE",
      "env add CLERK_SECRET_KEY production --force|sk_live_FAKE=with=equals",
    ];

    // A Preview or Development-only variable has no production target for
    // `--force` to rewrite, so it doesn't need the user.
    test
      .skipIf(!installed)
      .each(["none", "unrelated", "production_only", "preview_dev_only", "large"])(
      "replaces both production keys and exits 0 when %s",
      async (scenario) => {
        const result = await run(scenario);

        expect(result.exitCode).toBe(0);
        expect(result.uploads).toEqual(bothUploaded);
        expect(result.output).not.toContain("FAKE");
      },
    );

    test.skipIf(!installed)("lists the variables with color turned off", async () => {
      const result = await run("none");

      expect(result.listings).toEqual(["FORCE_COLOR=0 env ls --no-color"]);
    });

    // Any environment besides Production on the variable's line, custom ones included.
    test.skipIf(!installed).each(["shared", "colored_shared", "custom_env"])(
      "stops with exit 3 before uploading when %s",
      async (scenario) => {
        const result = await run(scenario);

        expect(result.exitCode).toBe(3);
        expect(result.uploads).toEqual([]);
        expect(result.output).toContain(
          "Also set for an environment other than Production: CLERK_SECRET_KEY",
        );
        expect(result.output).not.toContain("FAKE");
      },
    );

    test.skipIf(!installed)("stops with exit 1 when it can't read the variable list", async () => {
      const result = await run("unrecognized");

      expect(result.exitCode).toBe(1);
      expect(result.uploads).toEqual([]);
      expect(result.output).toContain("Couldn't read the variable list from vercel env ls");
    });

    // Consent lives in the command the user sees, for that one run.
    test.skipIf(!installed)("replaces a shared key when rerun with allow_shared=1", async () => {
      const command = keyCopyCommand();
      expect(command).toStartWith("( allow_shared=0; ");

      const result = await run("shared", {
        command: command.replace("allow_shared=0", "allow_shared=1"),
      });

      expect(result.exitCode).toBe(0);
      expect(result.uploads).toEqual(bothUploaded);
      expect(result.output).not.toContain("FAKE");
    });

    test.skipIf(!installed).each([
      {
        label: "allow_shared=1 exported in the environment",
        value: "0",
        env: { allow_shared: "1" },
      },
      { label: "allow_shared=yes", value: "yes", env: {} },
      { label: "allow_shared=2", value: "2", env: {} },
    ])("still stops with $label", async ({ value, env }) => {
      const result = await run("shared", {
        command: keyCopyCommand().replace("allow_shared=0", `allow_shared=${value}`),
        env: env as Record<string, string>,
      });

      expect(result.exitCode).toBe(3);
      expect(result.uploads).toEqual([]);
    });

    test
      .skipIf(!installed)
      .each(["pull_fails", "pull_prints_then_fails", "ls_fails", "first_upload_fails"])(
      "exits non-zero and uploads nothing more when %s",
      async (scenario) => {
        const result = await run(scenario);

        expect(result.exitCode).not.toBe(0);
        expect(result.uploads).toEqual([]);
        expect(result.output).not.toContain("FAKE");
      },
    );
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
    oauth: { complete: true, configured: [], pending: [], unsupported: [], setup: [] },
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
