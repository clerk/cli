import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { useCaptureLog, listageStubs } from "../../test/lib/stubs.ts";
import { CliError, ERROR_CODE, EXIT_CODE, PlapiError, UserAbortError } from "../../lib/errors.ts";

const mockIsAgent = mock();
let _modeOverride: string | undefined;

mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride === "agent" : mockIsAgent(...args),
  isHuman: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride !== "agent" : !mockIsAgent(...args),
  setMode: (m: string) => {
    _modeOverride = m;
  },
  getMode: () => _modeOverride ?? "human",
}));

const mockSelect = mock();
const mockInput = mock();
const mockConfirm = mock();
const mockPassword = mock();
const mockPatchInstanceConfig = mock();
const mockFetchInstanceConfig = mock();
const mockFetchInstanceConfigSchema = mock();
const mockFetchApplication = mock();
const mockListApplicationDomains = mock();
const mockCreateProductionInstance = mock();
const mockGetApplicationDomainStatus = mock();
const mockTriggerApplicationDomainDNSCheck = mock();
const mockSleep = mock();
const mockOpenBrowser = mock();

mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: (...args: unknown[]) => mockInput(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (...args: unknown[]) => mockSelect(...args),
  // filePath() collects a path the same way input() does; reuse the input mock
  // so existing mockInput.mockResolvedValueOnce(path) chains keep working.
  filePath: (...args: unknown[]) => mockInput(...args),
}));

mock.module("../../lib/plapi.ts", () => ({
  fetchInstanceConfig: (...args: unknown[]) => mockFetchInstanceConfig(...args),
  fetchInstanceConfigSchema: (...args: unknown[]) => mockFetchInstanceConfigSchema(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  listApplicationDomains: (...args: unknown[]) => mockListApplicationDomains(...args),
  createProductionInstance: (...args: unknown[]) => mockCreateProductionInstance(...args),
  getApplicationDomainStatus: (...args: unknown[]) => mockGetApplicationDomainStatus(...args),
  triggerApplicationDomainDNSCheck: (...args: unknown[]) =>
    mockTriggerApplicationDomainDNSCheck(...args),
  patchInstanceConfig: (...args: unknown[]) => mockPatchInstanceConfig(...args),
}));

mock.module("../../lib/sleep.ts", () => ({
  sleep: (...args: unknown[]) => {
    mockSleep(...args);
    return Promise.resolve();
  },
}));

mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

const { _setConfigDir, readConfig, setProfile } = await import("../../lib/config.ts");
const { deploy } = await import("./index.ts");
const { providerSetupIntro } = await import("./providers.ts");
const { collectCustomDomain } = await import("./prompts.ts");

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function promptExitError(): Error {
  const error = new Error("User force closed the prompt with SIGINT");
  error.name = "ExitPromptError";
  return error;
}

function domainStatus({
  status,
  dns,
  ssl,
  mail,
}: {
  status: "complete" | "incomplete";
  dns?: boolean;
  ssl?: boolean;
  mail?: boolean;
}) {
  return {
    status,
    ...(dns === undefined ? {} : { dns: { status: dns ? "complete" : "not_started", cnames: {} } }),
    ...(ssl === undefined
      ? {}
      : { ssl: { status: ssl ? "complete" : "not_started", required: true, failure_hints: [] } }),
    ...(mail === undefined
      ? {}
      : { mail: { status: mail ? "complete" : "not_started", required: true } }),
  };
}

const oauthSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  description: "OAuth SSO connection configuration",
  properties: {
    enabled: { type: "boolean", default: false },
    authenticatable: { type: "boolean", default: true },
    block_email_subaddresses: { type: "boolean", default: false },
    ...properties,
  },
});

const basicOAuthSchema = oauthSchema({
  client_id: { type: "string", description: "OAuth client ID" },
  client_secret: {
    type: "string",
    description: "OAuth client secret",
    "x-clerk-sensitive": true,
  },
});

const appleOAuthSchema = oauthSchema({
  client_id: { type: "string", description: "Apple Services ID" },
  client_secret: {
    type: "string",
    description: "Apple Private Key",
    "x-clerk-sensitive": true,
  },
  key_id: { type: "string", description: "Apple Key ID" },
  team_id: { type: "string", description: "Apple Team ID" },
  bundle_id: {
    type: "string",
    description: "iOS app Bundle ID for native Sign in with Apple",
  },
});

const linearOAuthSchema = oauthSchema({
  client_id: { type: "string", description: "Linear OAuth client ID" },
  client_secret: {
    type: "string",
    description: "Linear OAuth client secret",
    "x-clerk-sensitive": true,
  },
  actor: {
    type: "string",
    description: "Linear OAuth actor",
    enum: ["user", "application"],
    default: "user",
  },
});

const schemaResponse = (properties: Record<string, unknown>) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://clerk.com/schemas/platform-config/2025-01-01",
  type: "object",
  properties,
});

function schemaForEnabledOAuth(config: Record<string, unknown>) {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith("connection_oauth_")) continue;
    if (!value || typeof value !== "object") continue;
    if ((value as Record<string, unknown>).enabled !== true) continue;
    properties[key] = key === "connection_oauth_apple" ? appleOAuthSchema : basicOAuthSchema;
  }
  return schemaResponse(properties);
}

describe("deploy", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();
  let tempDir: string;

  beforeEach(() => {
    tempDir = "";
    // Sensible defaults so most tests need only override what they exercise.
    mockFetchInstanceConfig.mockResolvedValue({
      connection_oauth_google: { enabled: true },
    });
    mockFetchInstanceConfigSchema.mockResolvedValue(
      schemaResponse({
        connection_oauth_google: basicOAuthSchema,
      }),
    );
    mockFetchApplication.mockResolvedValue({
      application_id: "app_xyz789",
      name: "my-saas-app",
      instances: [
        {
          instance_id: "ins_dev_123",
          environment_type: "development",
          publishable_key: "pk_test_123",
        },
      ],
    });
    mockListApplicationDomains.mockResolvedValue({
      data: [
        {
          object: "domain",
          id: "dmn_prod_mock",
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
          created_at: "2026-05-06T00:00:00Z",
          updated_at: "2026-05-06T00:00:00Z",
        },
      ],
      total_count: 1,
    });
    mockGetApplicationDomainStatus.mockResolvedValue(
      domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
    );
    mockCreateProductionInstance.mockImplementation(
      (_appId: string, params: { domain: string }) => {
        const hostname = params.domain;
        return {
          object: "instance",
          id: "ins_prod_mock",
          environment_type: "production" as const,
          active_domain: {
            object: "domain",
            id: "dmn_prod_mock",
            name: hostname,
            is_satellite: false,
            is_provider_domain: false,
            frontend_api_url: `https://clerk.${hostname}`,
            development_origin: "",
            cname_targets: [
              {
                host: `clerk.${hostname}`,
                value: "frontend-api.clerk.services",
                required: true,
              },
              {
                host: `accounts.${hostname}`,
                value: "accounts.clerk.services",
                required: true,
              },
              {
                host: `clkmail.${hostname}`,
                value: `mail.${hostname}.nam1.clerk.services`,
                required: true,
              },
            ],
            created_at: "2026-05-06T00:00:00Z",
            updated_at: "2026-05-06T00:00:00Z",
          },
          publishable_key: "pk_live_test",
          secret_key: "sk_live_test",
          created_at: 1770000000000,
          updated_at: 1770000000000,
        };
      },
    );
    mockTriggerApplicationDomainDNSCheck.mockResolvedValue(
      domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
    );
    // Guard the real filesystem. When the BIND export prompt is accepted the
    // deploy flow writes `clerk-<domain>.zone` to the cwd, which would otherwise
    // leak an artifact into the repo on every run. Intercept only `.zone` writes
    // so config writes (setProfile) still hit disk in the temp dir.
    const realBunWrite = Bun.write.bind(Bun) as (...args: unknown[]) => Promise<number>;
    writeSpy = spyOn(Bun, "write").mockImplementation(((destination: unknown, ...rest: unknown[]) =>
      String(destination).endsWith(".zone")
        ? Promise.resolve(0)
        : realBunWrite(destination, ...rest)) as typeof Bun.write);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
    mockPassword.mockReset();
    mockPatchInstanceConfig.mockReset();
    mockFetchInstanceConfig.mockReset();
    mockFetchInstanceConfigSchema.mockReset();
    mockFetchApplication.mockReset();
    mockListApplicationDomains.mockReset();
    mockCreateProductionInstance.mockReset();
    mockGetApplicationDomainStatus.mockReset();
    mockTriggerApplicationDomainDNSCheck.mockReset();
    mockSleep.mockReset();
    mockOpenBrowser.mockReset();
    consoleSpy?.mockRestore();
    writeSpy?.mockRestore();
  });

  function runDeploy(options: Parameters<typeof deploy>[0] = {}) {
    return deploy(options);
  }

  async function runDeployUntilPause(options: Parameters<typeof deploy>[0] = {}) {
    try {
      await runDeploy(options);
    } catch (error) {
      if (!(error instanceof CliError) || !error.message.includes("Deploy paused")) {
        throw error;
      }
    }
  }

  async function linkedProject(profile: Record<string, unknown> = {}) {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-deploy-test-"));
    _setConfigDir(tempDir);
    const nextProfile = {
      workspaceId: "workspace_123",
      appId: "app_xyz789",
      appName: "my-saas-app",
      instances: { development: "ins_dev_123" },
      ...profile,
    } as never;
    await setProfile(process.cwd(), nextProfile);

    const typedProfile = nextProfile as {
      instances: { production?: string };
    };
    const productionInstanceId = typedProfile.instances.production;
    if (productionInstanceId) {
      mockLiveProduction({
        instanceId: productionInstanceId,
        domain: "example.com",
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
        },
      });
    }
  }

  function mockLiveProduction(
    options: {
      instanceId?: string;
      domain?: string;
      domainId?: string;
      productionConfig?: Record<string, unknown>;
      developmentConfig?: Record<string, unknown>;
      cnameTargets?: readonly { host: string; value: string; required: boolean }[];
    } = {},
  ) {
    const instanceId = options.instanceId ?? "ins_prod_mock";
    const domain = options.domain ?? "example.com";
    const domainId = options.domainId ?? "dmn_prod_mock";
    const developmentConfig = options.developmentConfig ?? {
      connection_oauth_google: { enabled: true },
    };
    const productionConfig = options.productionConfig ?? {
      connection_oauth_google: { enabled: false, client_id: "", client_secret: "" },
    };
    const cnameTargets = options.cnameTargets ?? [
      { host: `clerk.${domain}`, value: "frontend-api.clerk.services", required: true },
    ];

    mockFetchApplication.mockResolvedValue({
      application_id: "app_xyz789",
      name: "my-saas-app",
      instances: [
        {
          instance_id: "ins_dev_123",
          environment_type: "development",
          publishable_key: "pk_test_123",
        },
        {
          instance_id: instanceId,
          environment_type: "production",
          publishable_key: "pk_live_123",
        },
      ],
    });
    mockListApplicationDomains.mockResolvedValue({
      data: [
        {
          object: "domain",
          id: domainId,
          name: domain,
          is_satellite: false,
          is_provider_domain: false,
          frontend_api_url: `https://clerk.${domain}`,
          accounts_portal_url: `https://accounts.${domain}`,
          development_origin: "",
          cname_targets: cnameTargets,
          created_at: "2026-05-06T00:00:00Z",
          updated_at: "2026-05-06T00:00:00Z",
        },
      ],
      total_count: 1,
    });
    mockFetchInstanceConfig.mockImplementation((_appId: string, instanceIdOrEnv: string) => {
      if (instanceIdOrEnv === instanceId || instanceIdOrEnv === "production") {
        return productionConfig;
      }
      return developmentConfig;
    });
    mockFetchInstanceConfigSchema.mockResolvedValue(schemaForEnabledOAuth(developmentConfig));
  }

  test("provider setup intro includes docs-backed copy for each OAuth provider", () => {
    const intros = {
      google: providerSetupIntro("google").map(stripAnsi),
      github: providerSetupIntro("github").map(stripAnsi),
      microsoft: providerSetupIntro("microsoft").map(stripAnsi),
      apple: providerSetupIntro("apple").map(stripAnsi),
      linear: providerSetupIntro("linear").map(stripAnsi),
    };

    expect(intros.google).toEqual([
      "Configure Google OAuth for production",
      "Production Google sign-in requires custom OAuth credentials from Google Cloud Console.",
      "Reference: https://clerk.com/docs/authentication/social-connections/google",
    ]);
    expect(intros.github).toEqual([
      "Configure GitHub OAuth for production",
      "Production GitHub sign-in requires custom OAuth credentials.",
      "Reference: https://clerk.com/docs/authentication/social-connections/github",
    ]);
    expect(intros.microsoft).toEqual([
      "Configure Microsoft OAuth for production",
      "Production Microsoft sign-in requires custom OAuth credentials.",
      "Reference: https://clerk.com/docs/authentication/social-connections/microsoft",
    ]);
    expect(intros.apple).toEqual([
      "Configure Apple OAuth for production",
      "Production Apple sign-in requires an Apple Services ID, Team ID, Key ID, and private key file.",
      "Reference: https://clerk.com/docs/authentication/social-connections/apple",
    ]);
    expect(intros.linear).toEqual([
      "Configure Linear OAuth for production",
      "Production Linear sign-in requires custom OAuth credentials.",
      "Reference: https://clerk.com/docs/authentication/social-connections/linear",
    ]);
  });

  describe("agent mode", () => {
    test("not_started emits JSON handoff telling human to run wizard", async () => {
      mockIsAgent.mockReturnValue(true);
      await linkedProject();

      await runDeploy({});

      const payload = JSON.parse(captured.out);
      expect(payload.state).toBe("not_started");
      expect(payload.nextAction).toContain("clerk deploy");
      expect(payload.nextAction).toContain("clerk deploy status");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      await linkedProject();

      await runDeploy();

      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();
    });

    test("complete deploy emits no-action handoff", async () => {
      mockIsAgent.mockReturnValue(true);
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_mock" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_mock",
        domain: "example.com",
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
        },
      });

      await runDeploy({});

      const payload = JSON.parse(captured.out);
      expect(payload.state).toBe("complete");
      expect(payload.complete).toBe(true);
      expect(captured.err).toBe("");
      expect(mockTriggerApplicationDomainDNSCheck).not.toHaveBeenCalled();
      expect(mockSleep).not.toHaveBeenCalled();
      expect(mockCreateProductionInstance).not.toHaveBeenCalled();
      expect(mockPatchInstanceConfig).not.toHaveBeenCalled();
    });

    test("domain status read failures surface as errors", async () => {
      mockIsAgent.mockReturnValue(true);
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_mock" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_mock",
        domain: "example.com",
      });
      mockGetApplicationDomainStatus.mockRejectedValue(
        new PlapiError(500, JSON.stringify({ errors: [{ code: "server_error" }] }), "https://x"),
      );

      await expect(runDeploy({})).rejects.toBeInstanceOf(PlapiError);

      expect(captured.out).toBe("");
      expect(mockTriggerApplicationDomainDNSCheck).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();
    });
  });

  describe("human mode", () => {
    function mockHumanFlow() {
      mockIsAgent.mockReturnValue(false);
      // Proceed → create instance → show DNS records → pause at OAuth.
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("skip");
      mockInput.mockResolvedValueOnce("example.com");
    }

    async function runDnsHandoff() {
      mockHumanFlow();
      await runDeployUntilPause();
      mockLiveProduction();
      captured.clear();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
    }

    function mockOAuthCompletion() {
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("fake-client-id-12345");
      mockPassword.mockResolvedValueOnce("fake-secret");
    }

    test("does not print deploy prompt", async () => {
      await linkedProject();
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeployUntilPause();

      const allOutput = captured.out;
      expect(allOutput).not.toContain("deploying a Clerk application to production");
    });

    test("creates production instance without a separate clone-validation preflight", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeployUntilPause();

      expect(mockCreateProductionInstance).toHaveBeenCalledWith("app_xyz789", {
        clone_instance_id: "ins_dev_123",
        domain: "example.com",
        environment_type: "production",
      });
      expect(stripAnsi(captured.err)).not.toContain("Validating subscription compatibility");
    });

    test("checks for an existing production instance before reading development config", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);

      const productionCheckIndex = err.indexOf("Checking for production instance");
      const developmentConfigIndex = err.indexOf("Reading development configuration");
      expect(productionCheckIndex).toBeGreaterThan(-1);
      expect(developmentConfigIndex).toBeGreaterThan(-1);
      expect(productionCheckIndex).toBeLessThan(developmentConfigIndex);
    });

    test("discovers enabled OAuth providers by iterating the dev config response", async () => {
      await linkedProject();
      mockHumanFlow();
      mockFetchInstanceConfig.mockResolvedValueOnce({
        connection_oauth_google: { enabled: true },
        connection_oauth_github: { enabled: true },
        connection_oauth_microsoft: { enabled: false },
        connection_oauth_unknown: { enabled: true },
        unrelated_key: "ignored",
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({
          connection_oauth_google: basicOAuthSchema,
          connection_oauth_github: basicOAuthSchema,
        }),
      );

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);

      expect(mockFetchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_dev_123");
      expect(err).toContain("Configure Google OAuth credentials");
      expect(err).toContain("Configure GitHub OAuth credentials");
      expect(err).not.toContain("Configure Microsoft OAuth credentials");
      expect(err).toContain(
        "1 OAuth provider is enabled in development but not yet supported by automated `clerk deploy` setup.",
      );
      expect(err).not.toContain("unknown");
      expect(err).toContain("Configure them from the Clerk Dashboard before going live");
    });

    test("warns when enabled provider schema is not usable", async () => {
      await linkedProject();
      mockHumanFlow();
      mockFetchInstanceConfig.mockResolvedValueOnce({
        connection_oauth_discord: { enabled: true },
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({
          connection_oauth_discord: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              client_id: { type: "number" },
            },
          },
        }),
      );

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);

      expect(err).toContain(
        "1 OAuth provider is enabled in development but not yet supported by automated `clerk deploy` setup.",
      );
      expect(err).not.toContain("discord");
      expect(err).not.toContain("Discord");
      expect(err).not.toContain("Configure Discord OAuth credentials");
    });

    test("DNS verification polls getApplicationDomainStatus until complete", async () => {
      await linkedProject();
      // Proceed → create instance → check DNS now → complete OAuth.
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(mockGetApplicationDomainStatus).toHaveBeenCalledWith("app_xyz789", "dmn_prod_mock");
      expect(mockGetApplicationDomainStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(err).toContain("DNS verified for example.com");
      expect(err).toContain("Production ready at https://example.com");
    });

    test("DNS verification triggers a fresh DNS check before polling status", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockTriggerApplicationDomainDNSCheck.mockResolvedValueOnce(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockGetApplicationDomainStatus.mockResolvedValueOnce(
        domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
      );
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      expect(mockTriggerApplicationDomainDNSCheck).toHaveBeenCalledWith(
        "app_xyz789",
        "dmn_prod_mock",
      );
      expect(mockGetApplicationDomainStatus).toHaveBeenCalledWith("app_xyz789", "dmn_prod_mock");
      expect(mockTriggerApplicationDomainDNSCheck.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetApplicationDomainStatus.mock.invocationCallOrder[0]!,
      );
    });

    test("DNS verification retries status polling five times with exponential backoff", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect
        .mockResolvedValueOnce("have-credentials")
        .mockResolvedValueOnce("check")
        .mockResolvedValueOnce("skip");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      expect(mockGetApplicationDomainStatus).toHaveBeenCalledTimes(6);
      expect(mockSleep).toHaveBeenCalledTimes(93);
      expect(mockSleep.mock.calls.every(([delay]) => delay === 1000)).toBe(true);
    });

    test("Ctrl-C at the DNS retry prompt reports paused", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
        },
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockSelect.mockResolvedValueOnce("check").mockRejectedValueOnce(promptExitError());

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }

      expect(error?.message).toContain("Deploy paused at: DNS verification");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stripAnsi(captured.err);
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).not.toContain("Done");
    });

    test("DNS verification checks all domain status components together", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true) // Proceed?
        .mockResolvedValueOnce(true) // Create production instance?
        .mockResolvedValueOnce(false); // Export BIND zone file? (wired in Task 5; harmless when not yet consumed)
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("DNS verified for example.com");
      expect(err).not.toContain("Mail sender verified");
      expect(err).not.toContain("SSL certificate issued for example.com");
    });

    test("DNS verification uses one shared retry budget for all domain status components", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true) // Proceed?
        .mockResolvedValueOnce(true) // Create production instance?
        .mockResolvedValueOnce(false); // Export BIND zone file?
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("DNS verified for example.com");
      expect(mockGetApplicationDomainStatus).toHaveBeenCalledTimes(6);
    });

    test("DNS verification pauses when status stays incomplete despite all exposed booleans true (proxy_ok case)", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      // Every poll returns dns/ssl/mail all true but status incomplete (proxy_ok = false on server).
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: true, ssl: true, mail: true }),
      );
      mockConfirm.mockResolvedValueOnce(false); // BIND export prompt: skip (wired in Task 5)
      mockSelect.mockResolvedValueOnce("check");

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }
      const err = stripAnsi(captured.err);

      expect(error?.message).toContain("Deploy paused at: DNS verification");
      expect(error?.exitCode).toBe(EXIT_CODE.GENERAL);
      expect(err).toContain("Production setup for example.com is still finalizing.");
      expect(err).toContain("Paused");
      expect(err).not.toContain("Production ready at");
    });

    test("uses existing wizard framing and concise plan confirmation", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);

      expect(mockConfirm).toHaveBeenCalledWith({ message: "Proceed?", default: true });
      expect(err).toContain("clerk deploy will prepare my-saas-app for production");
      expect(err).toContain("[ ] Create production instance");
      expect(err).toContain("[ ] Verify DNS records");
      expect(err).toContain("[ ] Configure Google OAuth credentials");
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
    });

    test("asks directly for an owned production domain and accepts short domains", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeployUntilPause();

      const firstInputArg = mockInput.mock.calls[0]?.[0] as {
        message: string;
        validate: (value: string) => true | string;
      };
      expect(firstInputArg.message).toContain("Production domain");
      expect(firstInputArg.validate("x.io")).toBe(true);
      expect(firstInputArg.validate("https://example.com")).toContain("without https://");
      expect(firstInputArg.validate("example..com")).toContain("Enter a valid domain");
      expect(firstInputArg.validate("example-.com")).toContain("Enter a valid domain");
      expect(firstInputArg.validate("-example.com")).toContain("Enter a valid domain");
      expect(firstInputArg.validate("demo.vercel.app")).toContain(
        "Production needs a domain you own",
      );
      expect(firstInputArg.validate("demo.clerk.app")).toContain(
        "Production needs a domain you own",
      );
      expect(mockSelect).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: "How would you like to set up your production domain?",
        }),
      );
    });

    test("trims the collected production domain before returning it", async () => {
      mockInput.mockResolvedValueOnce(" example.com ");

      await expect(collectCustomDomain()).resolves.toBe("example.com");
    });

    test("Ctrl-C before changes are made reports paused instead of done", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockRejectedValueOnce(promptExitError());

      await expect(runDeploy({})).rejects.toBeInstanceOf(UserAbortError);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stripAnsi(captured.err);
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).toContain("Run `clerk deploy` again");
      expect(terminalOutput).not.toContain("Done");
    });

    test("Ctrl-C at domain collection reports paused instead of done", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true);
      mockInput.mockRejectedValueOnce(promptExitError());

      await expect(runDeploy({})).rejects.toBeInstanceOf(UserAbortError);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stripAnsi(captured.err);
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).toContain("Run `clerk deploy` again");
      expect(terminalOutput).not.toContain("Done");
    });

    test("prints production next steps after successful deploy", async () => {
      await linkedProject();
      await runDnsHandoff();
      mockOAuthCompletion();

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("Next steps");
      expect(err).toContain("clerk env pull --instance prod");
      expect(err).toContain("Update env vars on your hosting provider");
      expect(err).toContain(
        "https://dashboard.clerk.com/apps/app_xyz789/instances/ins_prod_mock/domains",
      );
      expect(err).toContain("Production keys only work on your production domain");
    });

    test("DNS setup prints dashboard handoff before OAuth without asking for verification", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true) // Proceed?
        .mockResolvedValueOnce(true) // Create production instance?
        .mockResolvedValueOnce(false); // Export DNS records as a BIND zone file?
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("skip");
      mockInput.mockResolvedValueOnce("example.com");

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);
      expect(err).toContain("Clerk will associate these subdomains with example.com");
      expect(err).toContain("clerk.example.com");
      expect(err).toContain("accounts.example.com");
      expect(err).toContain("clkmail.example.com");
      expect(err).toContain("This will create a Clerk production instance");
      expect(err).toContain("Add the following records at your DNS provider");
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("propagation and SSL issuance");
      expect(err).toContain("DNS propagation can take time");
      expect(mockConfirm).toHaveBeenCalledTimes(3);
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Create production instance?",
        default: true,
      });
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Export DNS records as a BIND zone file?",
        default: false,
      });
      expect(mockConfirm).not.toHaveBeenCalledWith({
        message: "Continue to OAuth setup?",
        default: true,
      });
      expect(mockSelect).not.toHaveBeenCalledWith({
        message: "DNS verification",
        choices: [
          { name: "Check DNS now", value: "check" },
          { name: "Skip DNS verification for now", value: "skip" },
        ],
      });
    });

    test("declining production instance creation does not call the production instance API", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("Clerk will associate these subdomains with example.com");
      expect(err).toContain("No production instance was created.");
      expect(mockCreateProductionInstance).not.toHaveBeenCalled();
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Create production instance?",
        default: true,
      });
    });

    test("throws a CliError when createProductionInstance returns no active_domain", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("example.com");
      mockCreateProductionInstance.mockResolvedValueOnce({
        object: "instance",
        id: "ins_prod_mock",
        environment_type: "production" as const,
        active_domain: null,
        publishable_key: "pk_live_test",
        secret_key: "sk_live_test",
        created_at: 1770000000000,
        updated_at: 1770000000000,
      });

      let thrown: unknown;
      try {
        await runDeploy({});
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).message).toContain("did not return a domain");
    });

    test("Ctrl-C at the DNS handoff reports paused", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(promptExitError());
      mockInput.mockResolvedValueOnce("example.com");

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }
      expect(error?.message).toContain("Deploy paused at: DNS verification");
      expect(error?.message).toContain("Run `clerk deploy` again");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stripAnsi(captured.err);
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).not.toContain("Done");
    });

    test("Google OAuth can load credentials from a downloaded JSON file", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      const googleJsonPath = join(tempDir, "client_secret_google.json");
      await Bun.write(
        googleJsonPath,
        JSON.stringify({
          web: {
            client_id: "google-json-client.apps.googleusercontent.com",
            client_secret: "fake-json-secret",
          },
        }),
      );
      await runDnsHandoff();
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("google-json");
      mockInput.mockResolvedValueOnce(googleJsonPath);
      await runDeploy({});
      const oauthSelect = mockSelect.mock.calls.find((call) =>
        String((call[0] as { message?: string }).message).includes("Google OAuth"),
      )?.[0] as { choices: Array<{ name: string; value: string }> };

      expect(oauthSelect.choices).toContainEqual({
        name: "Load credentials from a Google Cloud Console JSON file",
        value: "google-json",
      });
      expect(mockPassword).not.toHaveBeenCalled();
      expect(captured.err).toContain("Saved Google OAuth credentials");
    });

    test("Google OAuth walkthrough re-prompts with JSON import instead of another walkthrough", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      const googleJsonPath = join(tempDir, "client_secret_google.json");
      await Bun.write(
        googleJsonPath,
        JSON.stringify({
          web: {
            client_id: "google-json-client.apps.googleusercontent.com",
            client_secret: "fake-json-secret",
          },
        }),
      );
      await runDnsHandoff();
      mockOpenBrowser.mockResolvedValueOnce({ ok: true, launcher: "test" });
      mockSelect.mockResolvedValueOnce("walkthrough").mockResolvedValueOnce("google-json");
      mockInput.mockResolvedValueOnce(googleJsonPath);
      mockPassword.mockResolvedValueOnce("manual-secret");

      await runDeploy({});

      const oauthSelects = mockSelect.mock.calls
        .map(
          (call) =>
            call[0] as { message?: string; choices?: Array<{ name: string; value: string }> },
        )
        .filter((call) => String(call.message).includes("Google OAuth"));

      expect(mockOpenBrowser).toHaveBeenCalledWith(
        "https://clerk.com/docs/authentication/social-connections/google",
      );
      expect(oauthSelects).toHaveLength(2);
      expect(oauthSelects[1]?.choices).not.toContainEqual({
        name: "Walk me through creating them",
        value: "walkthrough",
      });
      expect(oauthSelects[1]?.choices).toContainEqual({
        name: "Load credentials from a Google Cloud Console JSON file",
        value: "google-json",
      });
      expect(mockPassword).not.toHaveBeenCalled();
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-json-client.apps.googleusercontent.com",
          client_secret: "fake-json-secret",
        },
      });
    });

    test("OAuth walkthrough re-prompts without another walkthrough for non-Google providers", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_github" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_github",
        developmentConfig: {
          connection_oauth_github: { enabled: true },
        },
        productionConfig: {
          connection_oauth_github: { enabled: true, client_id: "", client_secret: "" },
        },
      });
      mockOpenBrowser.mockResolvedValueOnce({ ok: true, launcher: "test" });
      mockSelect.mockResolvedValueOnce("walkthrough").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("github-client-id");
      mockPassword.mockResolvedValueOnce("github-secret");

      await runDeploy({});

      const oauthSelects = mockSelect.mock.calls
        .map(
          (call) =>
            call[0] as { message?: string; choices?: Array<{ name: string; value: string }> },
        )
        .filter((call) => String(call.message).includes("GitHub OAuth"));

      expect(oauthSelects).toHaveLength(2);
      expect(oauthSelects[1]?.choices).not.toContainEqual({
        name: "Walk me through creating them",
        value: "walkthrough",
      });
      expect(oauthSelects[1]?.choices).not.toContainEqual({
        name: "Load credentials from a Google Cloud Console JSON file",
        value: "google-json",
      });
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_github", {
        connection_oauth_github: {
          enabled: true,
          client_id: "github-client-id",
          client_secret: "github-secret",
        },
      });
    });

    test("Apple .p8 file prompt validates path and PEM framing before continuing", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_apple" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_apple",
        developmentConfig: {
          connection_oauth_apple: { enabled: true },
        },
        productionConfig: {
          connection_oauth_apple: {
            enabled: true,
            client_id: "",
            team_id: "",
            key_id: "",
            client_secret: "",
          },
        },
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({ connection_oauth_apple: appleOAuthSchema }),
      );
      mockIsAgent.mockReturnValue(false);

      const invalidP8Path = join(tempDir, "not-a-key.p8");
      const validP8Path = join(tempDir, "AuthKey.p8");
      await Bun.write(invalidP8Path, "not a real key");
      await Bun.write(
        validP8Path,
        "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n",
      );

      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput
        .mockResolvedValueOnce("apple-services-id")
        .mockResolvedValueOnce("apple-team-id")
        .mockResolvedValueOnce("apple-key-id")
        .mockResolvedValueOnce(validP8Path);
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_apple", {
        connection_oauth_apple: {
          enabled: true,
          client_id: "apple-services-id",
          team_id: "apple-team-id",
          key_id: "apple-key-id",
          client_secret:
            "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n",
        },
      });
      const p8Input = mockInput.mock.calls.find((call) =>
        String((call[0] as { message?: string }).message).includes("Apple Private Key"),
      )?.[0] as { validate: (value: string) => Promise<true | string> };
      await expect(p8Input.validate("nope")).resolves.toContain("No file at nope.");
      await expect(p8Input.validate(invalidP8Path)).resolves.toContain(
        "missing the -----BEGIN PRIVATE KEY----- framing",
      );
      await expect(p8Input.validate(validP8Path)).resolves.toBe(true);
      const relativeP8Path = relative(process.cwd(), validP8Path);
      await expect(p8Input.validate(relativeP8Path)).resolves.toBe(true);
    });

    test("Linear OAuth actor is collected from a select prompt", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      await runDnsHandoff();
      mockLiveProduction({
        developmentConfig: {
          connection_oauth_linear: { enabled: true },
        },
        productionConfig: {
          connection_oauth_linear: { enabled: true },
        },
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({ connection_oauth_linear: linearOAuthSchema }),
      );
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("application");
      mockInput.mockResolvedValueOnce("linear-client-id");
      mockPassword.mockResolvedValueOnce("linear-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_linear: {
          enabled: true,
          client_id: "linear-client-id",
          client_secret: "linear-secret",
          actor: "application",
        },
      });
    });

    test("Google OAuth JSON file prompt validates path and shape before continuing", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      const invalidJsonPath = join(tempDir, "not-google.json");
      const googleJsonPath = join(tempDir, "client_secret_google.json");
      await Bun.write(invalidJsonPath, JSON.stringify({ nope: true }));
      await Bun.write(
        googleJsonPath,
        JSON.stringify({
          web: {
            client_id: "google-json-client.apps.googleusercontent.com",
            client_secret: "fake-json-secret",
          },
        }),
      );
      await runDnsHandoff();
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("google-json");
      mockInput.mockResolvedValueOnce(googleJsonPath);
      await runDeploy({});

      const jsonInput = mockInput.mock.calls.find((call) =>
        String((call[0] as { message?: string }).message).includes("Google OAuth JSON file path"),
      )?.[0] as { validate: (value: string) => Promise<true | string> };
      await expect(jsonInput.validate("df")).resolves.toContain("No file at df.");
      await expect(jsonInput.validate(invalidJsonPath)).resolves.toContain(
        `That JSON file doesn't look like a Google OAuth client download`,
      );
      await expect(jsonInput.validate(googleJsonPath)).resolves.toBe(true);
      const relativeJsonPath = relative(process.cwd(), googleJsonPath);
      await expect(jsonInput.validate(relativeJsonPath)).resolves.toBe(true);
    });

    test("plain deploy is a no-op when the API reports deploy is already complete", async () => {
      await linkedProject();
      mockLiveProduction({
        instanceId: "ins_prod_from_api",
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
        },
      });
      mockIsAgent.mockReturnValue(false);

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("clerk deploy will prepare my-saas-app for production");
      expect(err).toContain("[x] Create production instance");
      expect(err).toContain("[x] Verify DNS records");
      expect(err).toContain("[x] Configure Google OAuth credentials");
      expect(err).toContain("No deploy actions remain.");
      expect(mockFetchApplication).toHaveBeenCalledWith("app_xyz789");
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    test("existing production warns generically when an enabled provider schema is not usable", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_unsupported" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_unsupported",
        developmentConfig: {
          connection_oauth_discord: { enabled: true },
        },
        productionConfig: {
          connection_oauth_discord: { enabled: true },
        },
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({
          connection_oauth_discord: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              client_id: { type: "number" },
            },
          },
        }),
      );
      mockIsAgent.mockReturnValue(false);

      await runDeploy({});
      const err = stripAnsi(captured.err);
      const warningIndex = err.indexOf(
        "1 OAuth provider is enabled in development but not yet supported by automated `clerk deploy` setup.",
      );
      const noActionsIndex = err.indexOf("No deploy actions remain.");
      const readyIndex = err.indexOf("Production ready at https://example.com");

      expect(warningIndex).toBeGreaterThan(-1);
      expect(noActionsIndex).toBeGreaterThan(-1);
      expect(readyIndex).toBeGreaterThan(-1);
      expect(warningIndex).toBeLessThan(noActionsIndex);
      expect(warningIndex).toBeLessThan(readyIndex);
      expect(err).not.toContain("discord");
      expect(err).not.toContain("Discord");
      expect(err).not.toContain("Configure Discord OAuth credentials");
    });

    test("resume treats redacted sensitive OAuth credentials as present", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_discord" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_discord",
        developmentConfig: {
          connection_oauth_discord: { enabled: true },
        },
        productionConfig: {
          connection_oauth_discord: {
            enabled: true,
            client_id: "discord-client-id",
            client_secret: "••••••••",
          },
        },
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({ connection_oauth_discord: basicOAuthSchema }),
      );
      mockIsAgent.mockReturnValue(false);
      mockSelect.mockResolvedValueOnce("next-steps");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("[x] Configure Discord OAuth credentials");
      expect(mockPassword).not.toHaveBeenCalled();
    });

    test("plain deploy resumes DNS verification from live API state", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        productionConfig: {},
      });
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("[x] Create production instance");
      expect(err).toContain("[ ] Verify DNS records");
      expect(err).toContain("[ ] Configure Google OAuth credentials");
      expect(err).toContain("DNS verified for example.com");
      expect(mockSelect).toHaveBeenCalledWith({
        message: "DNS verification",
        choices: [
          { name: "Check DNS now", value: "check" },
          { name: "Skip DNS verification for now", value: "skip" },
        ],
      });
      const firstInput = mockInput.mock.calls[0]?.[0] as { message?: string } | undefined;
      expect(String(firstInput?.message)).not.toContain("Production domain");
    });

    test("resume DNS verification prints CNAME records before the verification prompt", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockConfirm.mockResolvedValueOnce(false); // BIND export prompt placeholder (wired in Task 5)
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const recordsIdx = err.indexOf("Add the following records at your DNS provider");
      const promptIdx = err.indexOf("DNS verification");
      expect(recordsIdx).toBeGreaterThan(-1);
      expect(promptIdx).toBeGreaterThan(-1);
      expect(recordsIdx).toBeLessThan(promptIdx);
    });

    test("BIND export prompt writes the zone file when the user accepts", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockConfirm.mockResolvedValueOnce(true); // BIND export prompt: yes
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const zoneCall = writeSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).endsWith(".zone"),
      );
      expect(zoneCall).toBeDefined();
      const pathArg = zoneCall![0];
      const contentArg = zoneCall![1];
      expect(String(pathArg)).toMatch(/clerk-example\.com\.zone$/);
      expect(String(contentArg)).toContain("$ORIGIN example.com.");
      expect(String(contentArg)).toContain("$TTL 300");
      expect(String(contentArg)).toContain("IN\tCNAME");
      expect(err).toContain("Wrote ");
      expect(err).toContain("clerk-example.com.zone");
    });

    test("BIND export prompt writes no file when the user declines", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockConfirm.mockResolvedValueOnce(false); // BIND export prompt: no
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const zoneCall = writeSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).endsWith(".zone"),
      );
      expect(zoneCall).toBeUndefined();
      expect(err).not.toContain("Wrote ");
    });

    test("BIND export prompt is skipped when cnameTargets is empty", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
        cnameTargets: [], // override: domain has no CNAME targets
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      // confirm() was never called for the BIND prompt in this run.
      const bindPromptCalls = mockConfirm.mock.calls.filter((call) => {
        const arg = call[0] as { message?: string } | undefined;
        return typeof arg?.message === "string" && arg.message.includes("BIND zone file");
      });
      expect(bindPromptCalls.length).toBe(0);
      const zoneCall = writeSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).endsWith(".zone"),
      );
      expect(zoneCall).toBeUndefined();
    });

    test("DNS verification timeout names the specific pending components from domain status", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: true, ssl: false, mail: false }),
      );
      mockSelect.mockResolvedValueOnce("check").mockResolvedValueOnce("skip");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("SSL, email DNS still pending for example.com");
      expect(err).not.toContain("DNS, SSL, email DNS still pending");
    });

    test("DNS verification treats absent components as pending", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", ssl: true, mail: true }),
      );
      mockSelect.mockResolvedValueOnce("check").mockResolvedValueOnce("skip");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("DNS: pending  SSL: ✓  Email DNS: ✓");
      expect(err).toContain("DNS still pending for example.com");
      expect(err).not.toContain("Domain      Verified");
    });

    test("DNS verification timeout does not reprint DNS records when only SSL remains pending", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");
      mockSelect
        .mockResolvedValueOnce("have-credentials")
        .mockResolvedValueOnce("check")
        .mockResolvedValueOnce("skip");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: true, ssl: false, mail: true }),
      );

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("DNS: ✓  SSL: pending  Email DNS: ✓");
      expect(err).toContain("SSL still pending for example.com");
      expect(err.match(/Add the following records at your DNS provider:/g)).toHaveLength(1);
    });

    test("plain deploy can skip DNS verification and continue configuring production", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        productionConfig: {},
      });
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("skip");
      mockConfirm.mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("Saved Google OAuth credentials");
      expect(err).toContain("Domain      DNS pending");
      expect(err).not.toContain("Domain      Verified");
      expect(mockSelect).toHaveBeenCalledWith({
        message: "DNS verification",
        choices: [
          { name: "Check DNS now", value: "check" },
          { name: "Skip DNS verification for now", value: "skip" },
        ],
      });
      expect(mockGetApplicationDomainStatus).toHaveBeenCalledTimes(1);
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_123", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("DNS handoff points users to the Clerk Dashboard for propagation status", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("skip");
      mockInput.mockResolvedValueOnce("example.com");

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("DNS propagation can take time");
      expect(err).toContain("Configure Google OAuth for production");
    });

    test("Ctrl-C during OAuth setup reports plain deploy continuation", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      await runDnsHandoff();
      mockSelect.mockRejectedValueOnce(promptExitError());

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }
      expect(error?.message).toContain("Deploy paused at: Google OAuth credential setup");
      expect(error?.message).toContain("Run `clerk deploy` again");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stripAnsi(captured.err);
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).not.toContain("Done");
    });

    test("saves OAuth credentials to the production instance from live deploy state", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_created_456" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_created_456",
        productionConfig: {},
      });
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetApplicationDomainStatus.mockReset();
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );

      await runDeploy({});

      const err = stripAnsi(captured.err);
      expect(captured.err).toContain("\x1b[1mConfigure OAuth credentials for production\x1b[0m");
      expect(err).toContain("Configure Google OAuth for production");
      expect(err).toContain(
        "Production Google sign-in requires custom OAuth credentials from Google Cloud Console.",
      );
      expect(err).toContain(
        "Reference: https://clerk.com/docs/authentication/social-connections/google",
      );
      expect(mockConfirm).not.toHaveBeenCalledWith({
        message: "Set up Google OAuth now?",
        default: true,
      });
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_created_456", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("plain deploy resolves complete live API state without prompting", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        developmentConfig: {},
        productionConfig: {},
      });

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("[x] Create production instance");
      expect(err).toContain("[x] Verify DNS records");
      expect(err).toContain("No deploy actions remain.");
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("plain deploy persists production instance discovered from live API", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_live",
        developmentConfig: {},
        productionConfig: {},
      });

      await runDeploy({});

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_live");
    });

    test("custom-domain DNS setup can skip verification and later resume", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("skip");
      mockInput.mockResolvedValueOnce("example.com");

      await runDeployUntilPause();
      mockLiveProduction();
      expect(stripAnsi(captured.err)).toContain("Check the Domains section in the Clerk Dashboard");
      expect(stripAnsi(captured.err)).toContain("Configure Google OAuth for production");

      captured.clear();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("check");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetApplicationDomainStatus.mockReset();
      mockGetApplicationDomainStatus
        .mockResolvedValueOnce(
          domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
        )
        .mockResolvedValueOnce(
          domainStatus({ status: "complete", dns: true, ssl: true, mail: true }),
        );

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_mock");
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
      expect(err).toContain("DNS verified for example.com");
      expect(err).not.toContain("Issuing SSL certificates");
      expect(err).not.toContain("SSL certificates are usually issued");
      expect(err).not.toContain("SSL         Issuing");
      expect(err).toContain("Production ready at https://example.com");
    });

    test("OAuth setup can pause and resume at the pending provider", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      await runDnsHandoff();
      mockSelect.mockResolvedValueOnce("skip");

      let pauseError: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        pauseError = caught as CliError;
      }
      expect(pauseError?.message).toContain("Deploy paused at: Google OAuth credential setup");
      expect(pauseError?.message).toContain("Run `clerk deploy` again");
      expect(pauseError?.exitCode).toBe(EXIT_CODE.GENERAL);
      const pausedErr = stripAnsi(captured.err);
      expect(pausedErr).toContain("Paused");

      captured.clear();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_mock");
      expect(err).toContain("Saved Google OAuth credentials");
      expect(err).toContain("Production ready at https://example.com");
    });

    test("Pausing OAuth mid-loop infers earlier completed providers from production config", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockFetchInstanceConfig.mockResolvedValue({
        connection_oauth_google: { enabled: true },
        connection_oauth_github: { enabled: true },
      });
      mockFetchInstanceConfigSchema.mockResolvedValue(
        schemaResponse({
          connection_oauth_google: basicOAuthSchema,
          connection_oauth_github: basicOAuthSchema,
        }),
      );
      // Proceed → create prod → enter google creds → skip github before DNS verification.
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("skip");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      let pauseError: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        pauseError = caught as CliError;
      }
      expect(pauseError?.message).toContain("Deploy paused at: GitHub OAuth credential setup");
      expect(pauseError?.exitCode).toBe(EXIT_CODE.GENERAL);
      mockLiveProduction({
        developmentConfig: {
          connection_oauth_google: { enabled: true },
          connection_oauth_github: { enabled: true },
        },
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
          connection_oauth_github: { enabled: true, client_id: "", client_secret: "" },
        },
      });

      // Resume and finish: should not re-prompt for google, should finalize.
      captured.clear();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockPatchInstanceConfig.mockReset();
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("github-client-id");
      mockPassword.mockResolvedValueOnce("github-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);
      expect(mockPatchInstanceConfig).toHaveBeenCalledTimes(1);
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_github: {
          enabled: true,
          client_id: "github-client-id",
          client_secret: "github-secret",
        },
      });
      expect(err).toContain("Production ready at https://example.com");
    });

    test("OAuth success output stays attached to the save step before spacing the next provider", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_multi" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_multi",
        developmentConfig: {
          connection_oauth_apple: { enabled: true },
          connection_oauth_github: { enabled: true },
        },
        productionConfig: {
          connection_oauth_apple: {
            enabled: true,
            client_id: "",
            team_id: "",
            key_id: "",
            client_secret: "",
          },
          connection_oauth_github: { enabled: true, client_id: "", client_secret: "" },
        },
      });
      mockIsAgent.mockReturnValue(false);
      const validP8Path = join(tempDir, "AuthKey.p8");
      await Bun.write(
        validP8Path,
        "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n",
      );
      mockSelect
        .mockResolvedValueOnce("have-credentials")
        .mockResolvedValueOnce("have-credentials");
      mockInput
        .mockResolvedValueOnce("com.example.app")
        .mockResolvedValueOnce("TEAMID1234")
        .mockResolvedValueOnce("KEYID12345")
        .mockResolvedValueOnce(validP8Path)
        .mockResolvedValueOnce("github-client-id");
      mockPassword.mockResolvedValueOnce("github-secret");
      mockPatchInstanceConfig.mockResolvedValue({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain(
        "Saved Apple OAuth credentials\n│\n│  Configure GitHub OAuth for production",
      );
    });

    test("DNS verification timeout can skip and continue configuring production", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect
        .mockResolvedValueOnce("have-credentials")
        .mockResolvedValueOnce("check")
        .mockResolvedValueOnce("skip");
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetApplicationDomainStatus.mockResolvedValue(
        domainStatus({ status: "incomplete", dns: false, ssl: false, mail: false }),
      );

      await runDeploy({});
      const err = stripAnsi(captured.err);
      expect(err).toContain("DNS propagation can take several hours");
      expect(err).toContain("DNS, SSL, email DNS still pending for example.com");
      expect(err).toContain("DNS: pending");
      expect(err.match(/Add the following records at your DNS provider:/g)).toHaveLength(2);
      expect(err).toContain("Host:  clerk.example.com");
      expect(err).toContain("Value: frontend-api.clerk.services");
      expect(err).toContain("Skipping DNS verification for now.");
      expect(err).toContain("Saved Google OAuth credentials");
      expect(mockSelect).toHaveBeenCalledWith({
        message: "DNS verification",
        choices: [
          { name: "Skip DNS verification for now", value: "skip" },
          { name: "Check again", value: "check" },
        ],
      });
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("discovers and supports enabled OAuth providers from API schema", async () => {
      await linkedProject();
      mockHumanFlow();
      mockFetchInstanceConfig.mockResolvedValueOnce({
        connection_oauth_google: { enabled: true },
        connection_oauth_coinbase: { enabled: true },
        connection_oauth_twitter: { enabled: true },
        connection_oauth_discord: { enabled: true },
        connection_oauth_microsoft: { enabled: false },
        unrelated_key: "ignored",
      });
      mockFetchInstanceConfigSchema.mockResolvedValueOnce(
        schemaResponse({
          connection_oauth_google: basicOAuthSchema,
          connection_oauth_coinbase: basicOAuthSchema,
          connection_oauth_twitter: basicOAuthSchema,
          connection_oauth_discord: basicOAuthSchema,
        }),
      );

      await runDeployUntilPause();
      const err = stripAnsi(captured.err);

      expect(mockFetchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_dev_123");
      expect(mockFetchInstanceConfigSchema).toHaveBeenCalledWith("app_xyz789", "ins_dev_123", [
        "connection_oauth_google",
        "connection_oauth_coinbase",
        "connection_oauth_twitter",
        "connection_oauth_discord",
      ]);
      expect(err).toContain("Configure Google OAuth credentials");
      expect(err).toContain("Configure Coinbase OAuth credentials");
      expect(err).toContain("Configure Twitter OAuth credentials");
      expect(err).toContain("Configure Discord OAuth credentials");
      expect(err).not.toContain("Configure Microsoft OAuth credentials");
      expect(err).not.toContain("not yet supported by automated `clerk deploy` setup");
    });

    test("unlinked directory throws NOT_LINKED instead of warning and exiting 0", async () => {
      tempDir = await mkdtemp(join(tmpdir(), "clerk-deploy-test-"));
      _setConfigDir(tempDir);
      mockIsAgent.mockReturnValue(false);

      let thrown: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        thrown = caught as CliError;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(thrown?.code).toBe(ERROR_CODE.NOT_LINKED);
      expect(thrown?.message).toContain("No Clerk project linked");
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("recovers from 409 production_instance_exists and persists the recovered instance id", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("example.com");
      mockCreateProductionInstance.mockReset();
      mockCreateProductionInstance.mockRejectedValueOnce(
        new PlapiError(
          409,
          JSON.stringify({ errors: [{ code: "production_instance_exists", message: "exists" }] }),
        ),
      );
      // First fetchApplication call (during resolveDeployContext) sees no production
      // instance, so the wizard takes the startNewDeploy path and hits the 409.
      mockFetchApplication.mockResolvedValueOnce({
        application_id: "app_xyz789",
        name: "my-saas-app",
        instances: [
          {
            instance_id: "ins_dev_123",
            environment_type: "development",
            publishable_key: "pk_test_123",
          },
        ],
      });
      // Subsequent reads (the recovery refresh + reconcile) see the production
      // instance that another flow created, with google OAuth already configured.
      mockLiveProduction({
        instanceId: "ins_prod_recovered",
        productionConfig: {
          connection_oauth_google: {
            enabled: true,
            client_id: "google-client-id.apps.googleusercontent.com",
            client_secret: "REDACTED",
          },
        },
      });

      await runDeploy({});

      const err = stripAnsi(captured.err);
      expect(err).toContain("A production instance already exists");
      expect(err).toContain("Resuming the existing deploy");
      expect(err).toContain("Production ready at https://example.com");
      expect(mockFetchApplication.mock.calls.length).toBeGreaterThanOrEqual(2);
      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_recovered");
    });
  });
});
