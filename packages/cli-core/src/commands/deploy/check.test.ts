import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODE, PlapiError } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

let _modeOverride: string | undefined;

mock.module("../../mode.ts", () => ({
  isAgent: () => _modeOverride === "agent",
  isHuman: () => _modeOverride !== "agent",
  setMode: (mode: string) => {
    _modeOverride = mode;
  },
  getMode: () => _modeOverride ?? "human",
}));

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

mock.module("../../lib/sleep.ts", () => ({
  sleep: () => Promise.resolve(),
}));

const { _setConfigDir, setProfile } = await import("../../lib/config.ts");
const { deployCheck } = await import("./check.ts");

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

describe("deploy check", () => {
  const captured = useCaptureLog();
  let tempDir = "";
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(async () => {
    captured.clear();
    _modeOverride = "agent";
    exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    tempDir = await mkdtemp(join(tmpdir(), "clerk-check-test-"));
    _setConfigDir(tempDir);
    await setProfile(process.cwd(), {
      workspaceId: "",
      appId: "app_1",
      appName: "app",
      instances: { development: "ins_dev" },
    } as never);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    process.exitCode = exitCodeBefore ?? EXIT_CODE.SUCCESS;
    _modeOverride = undefined;
    tempDir = "";
    mockFetchApplication.mockReset();
    mockListApplicationDomains.mockReset();
    mockFetchInstanceConfig.mockReset();
    mockFetchInstanceConfigSchema.mockReset();
    mockGetApplicationDomainStatus.mockReset();
    mockTriggerApplicationDomainDNSCheck.mockReset();
  });

  test("agent mode not_started emits JSON with state not_started and exit 1", async () => {
    mockFetchApplication.mockResolvedValue(appWith(false));

    await deployCheck();

    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
    const payload = JSON.parse(captured.out);
    expect(payload.state).toBe("not_started");
    expect(payload.complete).toBe(false);
    expect(captured.out).not.toContain("error");
  });

  test("agent mode complete triggers DNS check and emits complete state", async () => {
    process.exitCode = EXIT_CODE.GENERAL;
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(completeDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(completeDomainStatus());

    await deployCheck();

    expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith("app_1", "dmn_1");
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
    _modeOverride = "human";
    mockFetchApplication.mockResolvedValue(appWith(false));

    await deployCheck();

    expect(captured.out).toBe("");
    expect(stripAnsi(captured.err)).toContain("clerk deploy");
  });

  test("agent mode domain pending reports pending DNS records and exit 1", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(pendingDnsDomainStatus());
    mockGetApplicationDomainStatus.mockResolvedValue(pendingDnsDomainStatus());

    await deployCheck();

    expect(process.exitCode).toBe(EXIT_CODE.GENERAL);
    const payload = JSON.parse(captured.out);
    expect(payload.state).toBe("domain_pending");
    expect(payload.complete).toBe(false);
    expect(payload.domainStatus).toEqual({ dns: "pending", ssl: "complete", mail: "complete" });
    expect(payload.pendingDnsRecords).toContainEqual({
      type: "CNAME",
      host: "clerk.example.com",
      value: "frontend-api.clerk.services",
    });
  });

  test("agent mode status snapshot failures surface as errors", async () => {
    mockFetchApplication.mockResolvedValue(appWith(true));
    mockDomain();
    mockOAuthComplete();
    mockGetApplicationDomainStatus.mockRejectedValue(
      new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
    );

    await expect(deployCheck()).rejects.toBeInstanceOf(PlapiError);

    expect(captured.out).toBe("");
    expect(mockTriggerApplicationDomainDNSCheck).not.toHaveBeenCalled();
  });
});
