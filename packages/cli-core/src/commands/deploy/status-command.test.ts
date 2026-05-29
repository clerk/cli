import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODE, PlapiError } from "../../lib/errors.ts";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";

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
const { deployStatus } = await import("./status-command.ts");

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
    process.exitCode = undefined;
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
    expect(stripAnsi(captured.err)).toContain("clerk deploy");
  });

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
      "SSL still provisioning for example.com. Re-run `clerk deploy status` in a few minutes, DNS propagation can take time. Visit the Clerk Dashboard domains page to monitor its status there: https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains",
    );
    expect(output).not.toContain("Ask the user to visit");
    expect(output).not.toContain("offer to open it");
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
