import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODE, PlapiError } from "../../lib/errors.ts";
import {
  captureTelemetryPayload,
  fakeTelemetryCommand,
  stubFetch,
  useCaptureLog,
} from "../../test/lib/stubs.ts";

const mockFetchApplication = mock();
const mockListApplicationDomains = mock();
const mockFetchInstanceConfig = mock();
const mockFetchInstanceConfigSchema = mock();
const mockGetApplicationDomainStatus = mock();
const mockTriggerApplicationDomainDNSCheck = mock();
const mockSleep = mock();

mock.module("../../lib/sleep.ts", () => ({
  sleep: (ms: number) => {
    mockSleep(ms);
    return Promise.resolve();
  },
}));

const { _setConfigDir, setProfile } = await import("../../lib/config.ts");
const { setMode } = await import("../../mode.ts");
const { beginInterrupt, interruptedExitCode, _resetInterruptState } =
  await import("../../lib/signals.ts");
const { deployStatus, humanNextAction } = await import("./status-command.ts");
const { startCommandTelemetry, telemetryResultForSoftExit } =
  await import("../../lib/telemetry.ts");

/** What an in-flight request rejects with once Ctrl-C aborts the shared signal. */
function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function appWith(production: boolean) {
  const instances = [{ instance_id: "ins_dev", environment_type: "development" }];
  if (production) instances.push({ instance_id: "ins_prod", environment_type: "production" });
  return { application_id: "app_1", name: "app", instances };
}

function completeDomainStatus() {
  return {
    status: "complete",
    dns: { status: "complete" },
    ssl: { status: "complete", required: true },
    mail: { status: "complete", required: true },
  };
}

function pendingDnsDomainStatus() {
  return {
    status: "incomplete",
    dns: { status: "not_started" },
    ssl: { status: "complete", required: true },
    mail: { status: "complete", required: true },
  };
}

function pendingSslDomainStatus() {
  return {
    status: "incomplete",
    dns: { status: "complete" },
    ssl: { status: "pending", required: true },
    mail: { status: "complete", required: true },
  };
}

function mockDomain() {
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
}

function mockOAuthComplete() {
  mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) =>
    instanceId === "ins_prod" || instanceId === "production"
      ? { connection_oauth_google: { enabled: true, client_id: "x", client_secret: "y" } }
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
}

describe("deploy status", () => {
  const captured = useCaptureLog();
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir = "";
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(async () => {
    captured.clear();
    setMode("agent");
    exitCodeBefore = process.exitCode;
    // Bun ignores `process.exitCode = undefined`; only a number resets it.
    process.exitCode = EXIT_CODE.SUCCESS;
    process.env.CLERK_PLATFORM_API_KEY = "ak_test";
    stubFetch((...args) => routePlapiFetch(...args));
    tempDir = await mkdtemp(join(tmpdir(), "clerk-status-test-"));
    _setConfigDir(tempDir);
    await setProfile(process.cwd(), {
      workspaceId: "",
      appId: "app_1",
      appName: "app",
      instances: { development: "ins_dev" },
    } as never);
  });

  afterEach(async () => {
    _resetInterruptState();
    _setConfigDir(undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    process.exitCode = exitCodeBefore ?? EXIT_CODE.SUCCESS;
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    setMode("human");
    tempDir = "";
    mockFetchApplication.mockReset();
    mockListApplicationDomains.mockReset();
    mockFetchInstanceConfig.mockReset();
    mockFetchInstanceConfigSchema.mockReset();
    mockGetApplicationDomainStatus.mockReset();
    mockTriggerApplicationDomainDNSCheck.mockReset();
    mockSleep.mockReset();
  });

  test("agent mode not_started emits JSON with state not_started and exit 1", async () => {
    mockFetchApplication.mockResolvedValue(appWith(false));

    await deployStatus();

    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
    const payload = JSON.parse(captured.out);
    expect(payload.state).toBe("not_started");
    expect(payload.complete).toBe(false);
    expect(captured.out).not.toContain("error");
    expect(mockTriggerApplicationDomainDNSCheck).not.toHaveBeenCalled();
  });

  test("agent mode complete triggers DNS check and emits complete state", async () => {
    process.exitCode = EXIT_CODE.GENERAL;
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

    await deployStatus();

    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(EXIT_CODE.SUCCESS);
    const payload = JSON.parse(captured.out);
    expect(payload).toMatchObject({
      complete: true,
      state: "complete",
      domain: "example.com",
    });
    expect(payload.domainStatus).toEqual({ dns: "complete", ssl: "complete", mail: "complete" });
  });

  test("human mode not_started prints a readable status block and no JSON stdout", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(false));

    await deployStatus();

    expect(captured.out).toBe("");
    const output = stripAnsi(captured.err);
    // The person reading this is the user, so the agent's "ask the user" is
    // reworded, and OAuth was never checked so its row is not printed.
    expect(output).toContain("No production instance yet.");
    expect(output).toContain("Run `clerk deploy` to set it up.");
    expect(output).not.toContain("ask the user");
    expect(output).not.toContain("human terminal");
    expect(output).not.toContain("OAuth");
  });

  test("human mode domain_provisioning does not claim OAuth was checked or address an agent", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockListApplicationDomains.mockResolvedValue({ data: [], total_count: 0 });

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain("its domain is still provisioning");
    expect(output).toContain("or run `clerk deploy` to finish setup.");
    expect(output).not.toContain("ask the user");
    expect(output).not.toContain("OAuth");
  });

  test("human mode oauth_pending tells the person to finish the wizard, not to ask themselves", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    // Production config has the provider enabled but no credentials.
    mockFetchInstanceConfig.mockImplementation(() => ({
      connection_oauth_google: { enabled: true },
    }));
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain("OAuth    pending: google");
    expect(output).toContain(
      "missing production credentials: google. Run `clerk deploy` to finish setup.",
    );
    expect(output).not.toContain("Ask the user");
    // The domain is verified; nothing to monitor on the Domains page.
    expect(output).not.toContain("domains page");
  });

  test("human mode records-missing says Clerk returned no list and how to resume", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
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
        },
      ],
      total_count: 1,
    });
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain(
      "DNS records not found yet for example.com, but Clerk didn't return the list of records to add. Find them on the Domains page in the Clerk Dashboard, add them, then run `clerk deploy` again to resume.",
    );
    expect(output).not.toContain("this report");
    expect(output).not.toContain("--wait");
    expect(output).not.toContain("Add the following records");
  });

  test("human mode says the unsupported-provider warning once, in its own row", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    // discord is enabled in both configs but absent from the schema, so the
    // CLI can't configure it: the "unsupported" case.
    mockFetchInstanceConfig.mockImplementation((_appId: string, instanceId: string) =>
      instanceId === "ins_prod" || instanceId === "production"
        ? {
            connection_oauth_google: { enabled: true, client_id: "x", client_secret: "y" },
            connection_oauth_discord: { enabled: true },
          }
        : {
            connection_oauth_google: { enabled: true },
            connection_oauth_discord: { enabled: true },
          },
    );
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain("not supported by automated deploy: discord");
    // The agent sentence carries the same fact; a person already has the row.
    expect(output).not.toContain("could not configure them for production");
    expect(JSON.stringify(captured.out)).not.toContain("could not configure");
  });

  test.each([
    {
      label: "finalizing",
      domain: () => ({ ...completeDomainStatus(), status: "incomplete" }),
      expected: "still finalizing on Clerk's side",
    },
    {
      label: "complete",
      domain: completeDomainStatus,
      expected:
        "Manage users, settings, and billing for this instance: https://dashboard.clerk.com/apps/app_1/instances/ins_prod",
    },
  ])(
    "human mode $label prints no records block and no agent copy",
    async ({ domain, expected }) => {
      setMode("human");
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockTriggerApplicationDomainDNSCheck.mockResolvedValue(domain());
      mockGetApplicationDomainStatus.mockResolvedValue(domain());

      await deployStatus();

      const output = stripAnsi(captured.err);
      expect(output).toContain(expected);
      expect(output).not.toContain("Add the following records");
      expect(output).not.toContain("Ask the user");
      expect(output).not.toContain("--wait");
    },
  );

  test("agent mode domain pending reports pending DNS records and exit 1", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployStatus();

    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
    expect(mockGetApplicationDomainStatus).toHaveBeenCalledTimes(1);
    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledTimes(1);
    expect(mockTriggerApplicationDomainDNSCheck.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetApplicationDomainStatus.mock.invocationCallOrder[0]!,
    );
    const payload = JSON.parse(captured.out);
    expect(payload.state).toBe("domain_pending");
    expect(payload.complete).toBe(false);
    expect(payload.domainStatus).toEqual({ dns: "pending", ssl: "complete", mail: "complete" });
    expect(payload.pendingDnsRecords).toContainEqual({
      type: "CNAME",
      host: "clerk.example.com",
      value: "frontend-api.clerk.services",
      required: true,
    });
  });

  test("agent mode status snapshot failures surface as errors", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockGetApplicationDomainStatus.mockRejectedValue(
      new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
    );

    await expect(deployStatus()).rejects.toBeInstanceOf(PlapiError);

    expect(captured.out).toBe("");
    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
  });

  test("human mode shows a spinner while waiting for the DNS check to process", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

    await deployStatus();

    expect(stripAnsi(captured.err)).toContain("Waiting for Clerk DNS check to process");
    expect(mockSleep).toHaveBeenCalledWith(2000);
  });

  test("agent mode Ctrl-C while resolving the linked application emits an interrupted report", async () => {
    // The first PLAPI read of the command, inside `resolveDeployContext`.
    mockFetchApplication.mockImplementation(() => {
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus()).rejects.toThrow();

    expect(JSON.parse(captured.out).state).toBe("interrupted");
  });

  test("agent mode Ctrl-C during the preflight emits an interrupted report", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockImplementation(() => {
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus()).rejects.toThrow();

    const payload = JSON.parse(captured.out);
    expect(payload).toMatchObject({ complete: false, state: "interrupted", domain: null });
    expect(payload.nextAction).toContain("Run `clerk deploy status` again");
    // The state read never happened, so the command must not claim there is no
    // production instance.
    expect(payload.state).not.toBe("not_started");
  });

  test("agent mode Ctrl-C during the state read emits an interrupted report", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockImplementation(() => {
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus()).rejects.toThrow();

    expect(JSON.parse(captured.out).state).toBe("interrupted");
  });

  test("agent mode Ctrl-C mid-wait reports what the last completed poll established", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    let polls = 0;
    mockGetApplicationDomainStatus.mockImplementation(() => {
      polls++;
      if (polls === 1) return pendingDnsDomainStatus();
      if (polls === 2) return pendingSslDomainStatus();
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus({ wait: true })).rejects.toThrow();

    const payload = JSON.parse(captured.out);
    expect(payload.state).toBe("domain_pending");
    // From the second poll, not the pre-wait snapshot — which still had DNS pending.
    expect(payload.domainStatus).toEqual({ dns: "complete", ssl: "pending", mail: "complete" });
  });

  // The interrupted report carries the last observation rather than a
  // hardcoded "not verified", so a deploy that was already complete when the
  // interrupt landed says so — the same thing telemetry records for it. The
  // exit code is what tells a script the command did not finish.
  test("agent mode Ctrl-C mid-wait on an already complete deploy still reports complete", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    let reads = 0;
    mockGetApplicationDomainStatus.mockImplementation(() => {
      reads++;
      if (reads === 1) return completeDomainStatus(); // the state read
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus({ wait: true })).rejects.toThrow();

    const payload = JSON.parse(captured.out);
    expect(payload).toMatchObject({ complete: true, state: "complete" });
    expect(interruptedExitCode()).toBe(EXIT_CODE.SIGINT);
  });

  test("human mode Ctrl-C during the preflight prints only the next action", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockImplementation(() => {
      beginInterrupt();
      throw abortError();
    });

    await expect(deployStatus()).rejects.toThrow();

    const output = stripAnsi(captured.err);
    expect(output).toContain("Interrupted before the deploy status could be read");
    expect(output).not.toContain("OAuth");
    expect(captured.out).toBe("");
  });

  test("human mode prints the pending records and refers to them, not to the JSON field", async () => {
    // The agent reads `pendingDnsRecords` from the JSON; a person has no JSON,
    // so the records are printed and the sentence points at them.
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain(
      "Add the following records at your DNS provider if you haven't already:",
    );
    expect(output).toContain("Host:  clerk.example.com");
    expect(output).toContain("Value: frontend-api.clerk.services");
    // The records block already says "add these"; the sentence says what's
    // next. Human mode already waits, so `--wait` is never suggested; the
    // wizard is what resumes setup.
    expect(output).toContain("Once they're added, run `clerk deploy` again to resume.");
    expect(output).not.toContain("--wait");
    expect(output).not.toContain("Add the records above");
    expect(output).not.toContain("pendingDnsRecords");
    expect(output).not.toContain("Ask the user");
  });

  test("human mode keeps Clerk's optional flag on a pending record instead of inventing one", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
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
            { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
            { host: "clk2._domainkey.example.com", value: "dkim2.clerk.services", required: false },
          ],
        },
      ],
      total_count: 1,
    });
    mockOAuthComplete();
    const pendingBoth = {
      status: "incomplete",
      dns: { status: "not_started" },
      ssl: { status: "complete", required: true },
      mail: { status: "not_started", required: true },
    };
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingBoth);
    mockGetApplicationDomainStatus.mockResolvedValue(pendingBoth);

    await deployStatus();

    const output = stripAnsi(captured.err);
    // The wizard prints the same record as optional; status must agree.
    expect(output).toMatch(
      /Email \(DKIM\) \(optional\)\n\s+Type:  CNAME\n\s+Host:  clk2\._domainkey\.example\.com/,
    );
    expect(output).not.toMatch(/Frontend API \(optional\)/);
  });

  test("human mode omits the email note when only non-email records are pending", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
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
            { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
            { host: "clkmail.example.com", value: "mail.clerk.services", required: true },
          ],
        },
      ],
      total_count: 1,
    });
    mockOAuthComplete();
    // Email DNS verified, Frontend API not: the filtered list has no email
    // row, so a sentence about "the email records" would point at nothing.
    const dnsOnly = {
      status: "incomplete",
      dns: { status: "not_started" },
      ssl: { status: "complete", required: true },
      mail: { status: "complete", required: true },
    };
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(dnsOnly);
    mockGetApplicationDomainStatus.mockResolvedValue(dnsOnly);

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain("Host:  clerk.example.com");
    expect(output).not.toContain("Host:  clkmail.example.com");
    expect(output).not.toContain("SPF or DKIM");
  });

  test("agent report carries each pending record's required flag", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployStatus();

    const payload = JSON.parse(captured.out);
    expect(payload.pendingDnsRecords).toEqual([
      {
        type: "CNAME",
        host: "clerk.example.com",
        value: "frontend-api.clerk.services",
        required: true,
      },
    ]);
  });

  test("agent report passes an optional record through as required: false", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
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
            { host: "clerk.example.com", value: "frontend-api.clerk.services", required: true },
            { host: "accounts.example.com", value: "accounts.clerk.services", required: false },
          ],
        },
      ],
      total_count: 1,
    });
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployStatus();

    const payload = JSON.parse(captured.out);
    expect(
      payload.pendingDnsRecords.map((r: { host: string; required: boolean }) => [
        r.host,
        r.required,
      ]),
    ).toEqual([
      ["clerk.example.com", true],
      ["accounts.example.com", false],
    ]);
  });

  test("human mode rewrites the agent clause for a plain-http Dashboard URL too", async () => {
    // Dashboard links follow CLERK_DASHBOARD_URL, which is http:// for a local
    // Dashboard; the human rewrite must not depend on https.
    const previous = process.env.CLERK_DASHBOARD_URL;
    process.env.CLERK_DASHBOARD_URL = "http://localhost:4000";
    try {
      setMode("human");
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingSslDomainStatus());
      mockGetApplicationDomainStatus.mockResolvedValue(pendingSslDomainStatus());

      await deployStatus();

      const output = stripAnsi(captured.err);
      expect(output).toContain(
        "Visit the Clerk Dashboard domains page to monitor its status there: http://localhost:4000/apps/app_1/instances/ins_prod/domains",
      );
      expect(output).not.toContain("Ask the user to visit");
    } finally {
      if (previous === undefined) delete process.env.CLERK_DASHBOARD_URL;
      else process.env.CLERK_DASHBOARD_URL = previous;
    }
  });

  test("human mode shows dashboard monitoring guidance without agent handoff copy", async () => {
    setMode("human");
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingSslDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingSslDomainStatus());

    await deployStatus();

    const output = stripAnsi(captured.err);
    expect(output).toContain(
      "SSL certificate still pending for example.com. Clerk issues it automatically now that DNS is verified; re-run `clerk deploy status` in a few minutes. Visit the Clerk Dashboard domains page to monitor its status there: https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
    );
    expect(output).not.toContain("Ask the user to visit");
    expect(output).not.toContain("offer to open it");
    // No records are outstanding, so no records block.
    expect(output).not.toContain("Add the following records");
  });

  // An unfinished deploy is not a failed command. These read the declaration
  // back through the classifier the soft-exit branch calls, so they pin what
  // would be recorded rather than that the setter ran. The whole path,
  // including `runProgram` itself, is covered end to end in
  // `test/integration/telemetry.test.ts`.
  describe("telemetry", () => {
    function recordedResult() {
      return telemetryResultForSoftExit(Number(process.exitCode ?? EXIT_CODE.SUCCESS));
    }

    test("a deploy with no production instance is incomplete, not an error", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(false));

      await deployStatus();

      expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
      expect(recordedResult()).toEqual({ outcome: "incomplete", exitCode: EXIT_CODE.GENERAL });
    });

    test("a provisioning domain is incomplete", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockListApplicationDomains.mockResolvedValue({ data: [], total_count: 0 });

      await deployStatus();

      expect(recordedResult()).toEqual({ outcome: "incomplete", exitCode: EXIT_CODE.GENERAL });
    });

    test("a deploy still waiting on DNS is incomplete", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
      mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

      await deployStatus();

      expect(recordedResult()).toEqual({ outcome: "incomplete", exitCode: EXIT_CODE.GENERAL });
    });

    test("a verified domain still missing OAuth credentials is incomplete", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockFetchInstanceConfig.mockImplementation(() => ({
        connection_oauth_google: { enabled: true },
      }));
      mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
      mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

      await deployStatus();

      expect(recordedResult()).toEqual({ outcome: "incomplete", exitCode: EXIT_CODE.GENERAL });
    });

    test("a complete deploy declares nothing and is a success at exit 0", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
      mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

      await deployStatus();

      expect(process.exitCode).toBe(EXIT_CODE.SUCCESS);
      expect(recordedResult()).toEqual({ outcome: "success", exitCode: EXIT_CODE.SUCCESS });
    });

    // The declaration is made only once the report exists, never optimistically
    // on the way in. Moving it above the status read would set it here and fail
    // this assertion, which is the regression this guards — a run that never
    // learned the deploy's state must not claim it is merely unfinished.
    test("a run that fails before it has a report declares nothing", async () => {
      startCommandTelemetry(fakeTelemetryCommand("deploy status"));
      mockFetchApplication.mockResolvedValue(appWith(true));
      mockDomain();
      mockOAuthComplete();
      mockGetApplicationDomainStatus.mockRejectedValue(
        new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
      );

      await expect(deployStatus()).rejects.toBeInstanceOf(PlapiError);

      expect(telemetryResultForSoftExit(EXIT_CODE.GENERAL)).toEqual({
        outcome: "error",
        exitCode: EXIT_CODE.GENERAL,
      });
    });

    // `stage` is the state the deploy was in when the run ended — the same
    // value the report's `state` field prints — and null when the run failed
    // before it had one. Read off the posted payload, since the stage travels
    // through the telemetry context rather than the report.
    describe("stage", () => {
      function statusTelemetry(options: Parameters<typeof deployStatus>[0] = {}) {
        return captureTelemetryPayload("deploy status", () => deployStatus(options), {
          captureError: true,
        });
      }

      test("no production instance is not_started", async () => {
        mockFetchApplication.mockResolvedValue(appWith(false));

        const { payload } = await statusTelemetry();

        expect(payload.stage).toBe("not_started");
        expect(payload.outcome).toBe("incomplete");
      });

      test("an instance without a domain yet is domain_provisioning", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockListApplicationDomains.mockResolvedValue({ data: [], total_count: 0 });

        const { payload } = await statusTelemetry();

        expect(payload.stage).toBe("domain_provisioning");
      });

      test("unverified DNS is domain_pending", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
        mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

        const { payload } = await statusTelemetry();

        expect(payload.stage).toBe("domain_pending");
      });

      test("a verified domain still missing OAuth credentials is oauth_pending", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockFetchInstanceConfig.mockImplementation(() => ({
          connection_oauth_google: { enabled: true },
        }));
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
        mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

        const { payload } = await statusTelemetry();

        expect(payload.stage).toBe("oauth_pending");
      });

      test("a finished deploy is complete", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
        mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

        const { payload } = await statusTelemetry();

        expect(payload.stage).toBe("complete");
        expect(payload.outcome).toBe("success");
      });

      test("under --wait the last poll's state is recorded", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
        mockGetApplicationDomainStatus
          .mockResolvedValueOnce(pendingDnsDomainStatus())
          .mockResolvedValueOnce(pendingSslDomainStatus())
          .mockResolvedValue(completeDomainStatus());

        const { payload } = await statusTelemetry({ wait: true });

        expect(payload.stage).toBe("complete");
        expect(payload.outcome).toBe("success");
      });

      test("Ctrl-C mid-wait keeps the state the last completed poll established", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
        let polls = 0;
        mockGetApplicationDomainStatus.mockImplementation(() => {
          polls++;
          if (polls <= 2) return pendingDnsDomainStatus();
          beginInterrupt();
          throw abortError();
        });

        const { payload, error } = await statusTelemetry({ wait: true });

        expect(error).toBeInstanceOf(DOMException);
        expect(payload.stage).toBe("domain_pending");
      });

      test("not linked fails before any state and records null", async () => {
        _setConfigDir(tempDir);
        await rm(join(tempDir, "config.json"), { force: true });

        const { payload } = await statusTelemetry();

        expect(payload.error_code).toBe("not_linked");
        expect(payload.stage).toBeNull();
      });

      // No state was established, so no stage — but the configuration read
      // that ran alongside the failed domain read did observe OAuth.
      test("a failed domain read records no stage and keeps the OAuth it did observe", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockGetApplicationDomainStatus.mockRejectedValue(
          new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
        );

        const { payload, error } = await statusTelemetry();

        expect(error).toBeInstanceOf(PlapiError);
        expect(payload.stage).toBeNull();
        expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: true });
      });
    });

    // The four readiness booleans, each from the read that observed it. DNS,
    // SSL and email DNS come from the domain-status response; OAuth from the
    // production configuration. Null means never observed, and is never
    // written as false by a failed read.
    describe("components", () => {
      function statusTelemetry(options: Parameters<typeof deployStatus>[0] = {}) {
        return captureTelemetryPayload("deploy status", () => deployStatus(options), {
          captureError: true,
        });
      }

      function pendingMailDomainStatus() {
        return {
          status: "incomplete",
          dns: { status: "complete" },
          ssl: { status: "complete", required: true },
          mail: { status: "pending", required: true },
        };
      }

      function allPendingDomainStatus() {
        return {
          status: "incomplete",
          dns: { status: "not_started" },
          ssl: { status: "not_started", required: true },
          mail: { status: "not_started", required: true },
        };
      }

      const combinations = [
        ["DNS only", pendingDnsDomainStatus, { dns: false, ssl: true, mail: true, oauth: true }],
        ["SSL only", pendingSslDomainStatus, { dns: true, ssl: false, mail: true, oauth: true }],
        [
          "email DNS only",
          pendingMailDomainStatus,
          { dns: true, ssl: true, mail: false, oauth: true },
        ],
        [
          "every domain component",
          allPendingDomainStatus,
          { dns: false, ssl: false, mail: false, oauth: true },
        ],
        ["nothing", completeDomainStatus, { dns: true, ssl: true, mail: true, oauth: true }],
      ] as const;

      for (const [pending, domainStatus, expected] of combinations) {
        test(`${pending} pending records the observed booleans`, async () => {
          mockFetchApplication.mockResolvedValue(appWith(true));
          mockDomain();
          mockOAuthComplete();
          mockTriggerApplicationDomainDNSCheck.mockResolvedValue(domainStatus());
          mockGetApplicationDomainStatus.mockResolvedValue(domainStatus());

          const { payload } = await statusTelemetry();

          expect(payload.components).toEqual(expected);
        });
      }

      test("OAuth only pending records oauth false with the domain verified", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockFetchInstanceConfig.mockImplementation(() => ({
          connection_oauth_google: { enabled: true },
        }));
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
        mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

        const { payload } = await statusTelemetry();

        expect(payload.components).toEqual({ dns: true, ssl: true, mail: true, oauth: false });
      });

      test("polls under --wait update the domain group and leave oauth as first observed", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
        mockGetApplicationDomainStatus
          .mockResolvedValueOnce(pendingDnsDomainStatus())
          .mockResolvedValueOnce(pendingSslDomainStatus())
          .mockResolvedValue(completeDomainStatus());

        const { payload } = await statusTelemetry({ wait: true });

        expect(payload.components).toEqual({ dns: true, ssl: true, mail: true, oauth: true });
        // Guards against a future per-poll configuration read. Unrelated to why
        // polls leave `oauth` alone, which is that they never observed it.
        expect(mockFetchInstanceConfig).toHaveBeenCalledTimes(2);
      });

      test("a failed poll after a successful state read keeps what the read observed", async () => {
        mockFetchApplication.mockResolvedValue(appWith(true));
        mockDomain();
        mockOAuthComplete();
        mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
        mockGetApplicationDomainStatus
          .mockResolvedValueOnce(pendingDnsDomainStatus())
          .mockRejectedValue(
            new PlapiError(
              500,
              JSON.stringify({ errors: [{ code: "server_error" }] }),
              "https://x",
            ),
          );

        const { payload, error } = await statusTelemetry({ wait: true });

        expect(error).toBeInstanceOf(PlapiError);
        expect(payload.stage).toBe("domain_pending");
        expect(payload.components).toEqual({ dns: false, ssl: true, mail: true, oauth: true });
      });
    });
  });
});

async function routePlapiFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input.toString());
  const method = init?.method ?? "GET";
  const path = url.pathname;
  const json = async (value: unknown) => {
    const body = await value;
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  if (method === "GET" && path === "/v1/platform/applications/app_1") {
    return json(mockFetchApplication("app_1"));
  }
  if (method === "GET" && path === "/v1/platform/applications/app_1/domains") {
    return json(mockListApplicationDomains("app_1"));
  }
  if (method === "GET" && path.endsWith("/config/schema")) {
    const instanceId = path.split("/").at(-3)!;
    return json(
      mockFetchInstanceConfigSchema("app_1", instanceId, url.searchParams.getAll("keys")),
    );
  }
  if (method === "GET" && path.endsWith("/config")) {
    const instanceId = path.split("/").at(-2)!;
    return json(mockFetchInstanceConfig("app_1", instanceId));
  }
  if (method === "POST" && path.endsWith("/dns_check")) {
    const domainIdOrName = path.split("/").at(-2)!;
    return json(mockTriggerApplicationDomainDNSCheck("app_1", domainIdOrName));
  }
  if (method === "GET" && path.endsWith("/status")) {
    const domainIdOrName = path.split("/").at(-2)!;
    return json(mockGetApplicationDomainStatus("app_1", domainIdOrName));
  }

  return new Response("Not Found", { status: 404 });
}

describe("humanNextAction", () => {
  // These are the three things that used to leak from the agent sentence into
  // the human one. Now that each audience has its own renderer, this pins the
  // human side for every state rather than trusting seven replace rules.
  const URL = "https://dashboard.clerk.com/apps/app_1/instances/ins_prod";
  const steps = [
    { kind: "not_started" as const },
    { kind: "domain_provisioning" as const, domainsUrl: `${URL}/domains` },
    { kind: "interrupted" as const },
    { kind: "complete" as const, domain: "example.com", oauthUnsupported: ["x"], instanceUrl: URL },
    { kind: "oauth_pending" as const, oauthPending: ["github"], oauthUnsupported: ["x"] },
    ...(["records_available", "records_unavailable", "ssl_pending", "finalizing"] as const).map(
      (kind) => ({ kind, domain: "example.com", records: "DNS", domainsUrl: `${URL}/domains` }),
    ),
  ];

  test.each(steps.map((step) => ({ kind: step.kind, step })))(
    "never speaks to an agent: $kind",
    ({ step }) => {
      const line = humanNextAction(step);
      expect(line).not.toContain("ask the user");
      expect(line).not.toContain("Ask the user");
      expect(line).not.toContain("pendingDnsRecords");
      expect(line).not.toContain("--wait");
      expect(line).not.toContain("human terminal");
      // The warning row above the sentence already names unsupported providers.
      expect(line).not.toContain("could not configure them");
    },
  );

  test("points a person at the wizard to resume, and at the Dashboard to watch", () => {
    const line = humanNextAction({
      kind: "records_available",
      domain: "example.com",
      records: "DNS",
      domainsUrl: `${URL}/domains`,
    });
    expect(line).toBe(
      "DNS records not found yet for example.com. Once they're added, run `clerk deploy` again to resume. " +
        `Propagation usually takes minutes. Visit the Clerk Dashboard domains page to monitor its status there: ${URL}/domains`,
    );
  });
});
