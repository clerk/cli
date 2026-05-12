import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { captureLog, promptsStubs, listageStubs } from "../../test/lib/stubs.ts";
import { CliError, EXIT_CODE, UserAbortError } from "../../lib/errors.ts";

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
const mockFetchApplication = mock();
const mockListApplicationDomains = mock();
const mockCreateProductionInstance = mock();
const mockValidateCloning = mock();
const mockGetDeployStatus = mock();
const mockRetrySSL = mock();
const mockRetryMail = mock();
const mockDomainConnectUrl = mock();

mock.module("@inquirer/prompts", () => ({
  ...promptsStubs,
  select: (...args: unknown[]) => mockSelect(...args),
  input: (...args: unknown[]) => mockInput(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));

mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (...args: unknown[]) => mockSelect(...args),
}));

mock.module("../../lib/plapi.ts", () => ({
  fetchInstanceConfig: (...args: unknown[]) => mockFetchInstanceConfig(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  listApplicationDomains: (...args: unknown[]) => mockListApplicationDomains(...args),
}));

mock.module("./api.ts", () => ({
  createProductionInstance: (...args: unknown[]) => mockCreateProductionInstance(...args),
  validateCloning: (...args: unknown[]) => mockValidateCloning(...args),
  getDeployStatus: (...args: unknown[]) => mockGetDeployStatus(...args),
  retryApplicationDomainSSL: (...args: unknown[]) => mockRetrySSL(...args),
  retryApplicationDomainMail: (...args: unknown[]) => mockRetryMail(...args),
  patchInstanceConfig: (...args: unknown[]) => mockPatchInstanceConfig(...args),
}));

mock.module("./domain-connect.ts", () => ({
  domainConnectUrl: (...args: unknown[]) => mockDomainConnectUrl(...args),
}));

mock.module("../../lib/sleep.ts", () => ({
  sleep: () => Promise.resolve(),
}));

const { _setConfigDir, readConfig, setProfile } = await import("../../lib/config.ts");
const { deploy } = await import("./index.ts");
const { providerSetupIntro } = await import("./providers.ts");

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function promptExitError(): Error {
  const error = new Error("User force closed the prompt with SIGINT");
  error.name = "ExitPromptError";
  return error;
}

describe("deploy", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn> | undefined;
  let captured: ReturnType<typeof captureLog>;
  let tempDir: string;

  beforeEach(() => {
    captured = captureLog();
    tempDir = "";
    // Sensible defaults so most tests need only override what they exercise.
    mockFetchInstanceConfig.mockResolvedValue({
      connection_oauth_google: { enabled: true },
    });
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
    mockValidateCloning.mockResolvedValue(undefined);
    mockGetDeployStatus.mockResolvedValue({ status: "complete" });
    mockCreateProductionInstance.mockImplementation(
      (_appId: string, params: { home_url: string }) => ({
        instance_id: "ins_prod_mock",
        environment_type: "production" as const,
        active_domain: { id: "dmn_prod_mock", name: params.home_url },
        publishable_key: "pk_live_test",
        secret_key: "sk_live_test",
        cname_targets: [
          {
            host: `clerk.${params.home_url}`,
            value: "frontend-api.clerk.services",
            required: true,
          },
          {
            host: `accounts.${params.home_url}`,
            value: "accounts.clerk.services",
            required: true,
          },
          {
            host: `clkmail.${params.home_url}`,
            value: `mail.${params.home_url}.nam1.clerk.services`,
            required: true,
          },
        ],
      }),
    );
    mockDomainConnectUrl.mockReturnValue(undefined);
  });

  afterEach(async () => {
    captured.teardown();
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
    mockFetchApplication.mockReset();
    mockListApplicationDomains.mockReset();
    mockCreateProductionInstance.mockReset();
    mockValidateCloning.mockReset();
    mockGetDeployStatus.mockReset();
    mockRetrySSL.mockReset();
    mockRetryMail.mockReset();
    mockDomainConnectUrl.mockReset();
    consoleSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  function runDeploy(options: Parameters<typeof deploy>[0]) {
    return captured.run(() => deploy(options));
  }

  async function expectTestApiFailure(promise: Promise<unknown>, message: string): Promise<Error> {
    let error: Error | undefined;
    try {
      await promise;
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CliError);
    expect(error?.message).toContain(message);
    return error!;
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
          cname_targets: [
            { host: `clerk.${domain}`, value: "frontend-api.clerk.services", required: true },
          ],
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
      "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google",
    ]);
    expect(intros.github).toEqual([
      "Configure GitHub OAuth for production",
      "Production GitHub sign-in requires a GitHub OAuth app and custom credentials.",
      "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github",
    ]);
    expect(intros.microsoft).toEqual([
      "Configure Microsoft OAuth for production",
      "Production Microsoft sign-in requires a Microsoft Entra ID app and custom credentials.",
      "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/microsoft",
    ]);
    expect(intros.apple).toEqual([
      "Configure Apple OAuth for production",
      "Production Apple sign-in requires an Apple Services ID, Team ID, Key ID, and private key file.",
      "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple",
    ]);
    expect(intros.linear).toEqual([
      "Configure Linear OAuth for production",
      "Production Linear sign-in requires a Linear OAuth app and custom credentials.",
      "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/linear",
    ]);
  });

  describe("agent mode", () => {
    test("exits with human mode guidance", async () => {
      mockIsAgent.mockReturnValue(true);

      await expect(runDeploy({})).rejects.toMatchObject({
        code: "usage_error",
        exitCode: EXIT_CODE.USAGE,
        message:
          "clerk deploy requires human mode because production configuration uses interactive prompts. Run `clerk deploy --mode human` from an interactive terminal.",
      });

      expect(captured.out).toBe("");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);

      await expect(runDeploy({ debug: true })).rejects.toBeInstanceOf(CliError);

      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockPassword).not.toHaveBeenCalled();
    });
  });

  describe("human mode", () => {
    function mockHumanFlow() {
      mockIsAgent.mockReturnValue(false);
      // Proceed → pause after DNS handoff.
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");
    }

    async function runDnsHandoff() {
      mockHumanFlow();
      await runDeploy({});
      mockLiveProduction();
      captured = captureLog();
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

      await runDeploy({});

      const allOutput = captured.out;
      expect(allOutput).not.toContain("deploying a Clerk application to production");
    });

    test("calls validate_cloning preflight before plan summary", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeploy({});

      expect(mockValidateCloning).toHaveBeenCalledWith("app_xyz789", {
        clone_instance_id: "ins_dev_123",
      });
    });

    test("checks for an existing production instance before reading development config", async () => {
      await linkedProject();
      mockHumanFlow();
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      await runDeploy({});
      const err = stripAnsi(
        stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join(""),
      );

      const productionCheckIndex = err.indexOf("Checking for production instance...");
      const developmentConfigIndex = err.indexOf("Reading development configuration...");
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

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(mockFetchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_dev_123");
      expect(err).toContain("Configure Google OAuth credentials");
      expect(err).toContain("Configure GitHub OAuth credentials");
      expect(err).not.toContain("Configure Microsoft OAuth credentials");
      expect(err).toContain("not yet supported by `clerk deploy`: unknown");
      expect(err).toContain("Configure them from the Clerk Dashboard before going live");
    });

    test("DNS verification polls getDeployStatus until complete", async () => {
      await linkedProject();
      // Proceed → continue after DNS handoff → complete OAuth.
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockGetDeployStatus
        .mockResolvedValueOnce({ status: "incomplete" })
        .mockResolvedValueOnce({ status: "complete" });
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(mockGetDeployStatus).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock");
      expect(mockGetDeployStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(err).toContain("DNS verified for example.com");
      expect(err).toContain("Production ready at https://example.com");
    });

    test("uses existing wizard framing and concise plan confirmation", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(mockConfirm).toHaveBeenCalledWith({ message: "Proceed?", default: true });
      expect(err).toContain("clerk deploy will prepare my-saas-app for production");
      expect(err).toContain("[ ] Create production instance");
      expect(err).toContain("[ ] Configure DNS records");
      expect(err).toContain("[ ] Configure Google OAuth credentials");
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
    });

    test("asks directly for an owned production domain and accepts short domains", async () => {
      await linkedProject();
      mockHumanFlow();

      await runDeploy({});

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

    test("Ctrl-C before changes are made reports cancelled instead of done", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockRejectedValueOnce(promptExitError());
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      await expect(runDeploy({})).rejects.toBeInstanceOf(UserAbortError);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Cancelled");
      expect(terminalOutput).not.toContain("Done");
    });

    test("Ctrl-C at domain collection reports cancelled instead of done", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true);
      mockInput.mockRejectedValueOnce(promptExitError());
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      await expect(runDeploy({})).rejects.toBeInstanceOf(UserAbortError);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Cancelled");
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
      expect(err).toContain("Production keys only work on your production domain");
    });

    test("DNS setup prints dashboard handoff and asks before continuing", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      const err = stripAnsi(captured.err);
      expect(err).toContain("Clerk will associate these subdomains with example.com");
      expect(err).toContain("clerk.example.com");
      expect(err).toContain("accounts.example.com");
      expect(err).toContain("clkmail.example.com");
      expect(err).toContain("This will create a Clerk production instance");
      expect(err).toContain("Add the following records at your DNS provider");
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("propagation and SSL issuance");
      expect(err).toContain("run `clerk deploy` again later");
      expect(mockConfirm).toHaveBeenCalledTimes(3);
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Create production instance?",
        default: true,
      });
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Continue to OAuth setup?",
        default: true,
      });
      expect(mockConfirm).not.toHaveBeenCalledWith({
        message: "Configure and verify DNS now?",
        default: true,
      });
      expect(mockConfirm).not.toHaveBeenCalledWith({
        message: "Have the DNS records been added?",
        default: true,
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

    test("Ctrl-C at the DNS handoff reports paused", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(promptExitError());
      mockInput.mockResolvedValueOnce("example.com");
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }
      expect(error?.message).toContain("Deploy paused at: DNS verification");
      expect(error?.message).toContain("Run `clerk deploy` again");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
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
      expect(err).toContain("[x] Configure DNS records");
      expect(err).toContain("[x] Configure Google OAuth credentials");
      expect(err).toContain("No deploy actions remain.");
      expect(mockFetchApplication).toHaveBeenCalledWith("app_xyz789");
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    test("--test-force-production-instance makes app retrieval include mocked production", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockSelect.mockResolvedValueOnce("skip");
      mockListApplicationDomains.mockRejectedValueOnce(
        new Error("domains should be mocked when forcing production"),
      );
      mockFetchInstanceConfig.mockImplementation((_appId: string, instanceIdOrEnv: string) => {
        if (instanceIdOrEnv === "ins_prod_mock") {
          throw new Error("production config should be mocked when forcing production");
        }
        return { connection_oauth_google: { enabled: true } };
      });

      await runDeploy({ testForceProductionInstance: true });
      const err = stripAnsi(captured.err);

      expect(err).toContain("[x] Create production instance");
      expect(err).toContain("Use production domain example.com");
      expect(mockCreateProductionInstance).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_xyz789");
      expect(mockListApplicationDomains).not.toHaveBeenCalled();
      expect(mockFetchInstanceConfig).not.toHaveBeenCalledWith("app_xyz789", "ins_prod_mock");
    });

    test("--test-fail-production-instance-check simulates production instance lookup failure", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);

      await expectTestApiFailure(
        runDeploy({ testFailProductionInstanceCheck: true }),
        "Simulated deploy failure: production instance check.",
      );

      expect(mockFetchApplication).toHaveBeenCalledWith("app_xyz789");
      expect(mockFetchInstanceConfig).not.toHaveBeenCalled();
    });

    test("--test-fail-production-instance-check prints Failed in interactive output", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
      const originalCi = process.env.CI;
      const originalIsTty = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
      delete process.env.CI;

      try {
        await expectTestApiFailure(
          runDeploy({ testFailProductionInstanceCheck: true }),
          "Simulated deploy failure: production instance check.",
        );
      } finally {
        Object.defineProperty(process.stderr, "isTTY", {
          configurable: true,
          value: originalIsTty,
        });
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
      }

      const terminalOutput = stripAnsi(
        stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join(""),
      );
      expect(terminalOutput).toContain("Failed");
    });

    test("--test-fail-domain-lookup simulates production domain lookup failure", async () => {
      await linkedProject();
      mockLiveProduction({
        instanceId: "ins_prod_from_api",
        productionConfig: {},
      });
      mockIsAgent.mockReturnValue(false);

      await expectTestApiFailure(
        runDeploy({ testFailDomainLookup: true }),
        "Simulated deploy failure: production domain lookup.",
      );

      expect(mockListApplicationDomains).toHaveBeenCalledWith("app_xyz789");
    });

    test("--test-fail-validate-cloning simulates cloning validation failure", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);

      await expectTestApiFailure(
        runDeploy({ testFailValidateCloning: true }),
        "Simulated deploy failure: cloning validation.",
      );

      expect(mockValidateCloning).toHaveBeenCalledWith("app_xyz789", {
        clone_instance_id: "ins_dev_123",
      });
      expect(mockCreateProductionInstance).not.toHaveBeenCalled();
    });

    test("--test-fail-create-production-instance simulates production creation failure", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("example.com");

      await expectTestApiFailure(
        runDeploy({ testFailCreateProductionInstance: true }),
        "Simulated deploy failure: production instance creation.",
      );

      expect(mockCreateProductionInstance).toHaveBeenCalledWith("app_xyz789", {
        home_url: "example.com",
        clone_instance_id: "ins_dev_123",
      });
    });

    test("--test-fail-dns-verification simulates DNS verification failure", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await expectTestApiFailure(
        runDeploy({ testFailDnsVerification: true }),
        "Simulated deploy failure: DNS verification.",
      );

      expect(mockGetDeployStatus).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock");
      expect(mockPatchInstanceConfig).not.toHaveBeenCalled();
    });

    test("--test-fail-oauth-save simulates OAuth credential save failure", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockLiveProduction({
        instanceId: "ins_prod_123",
        productionConfig: {},
      });
      mockIsAgent.mockReturnValue(false);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockConfirm.mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");

      await expectTestApiFailure(
        runDeploy({ testFailOAuthSave: true }),
        "Simulated deploy failure: OAuth credential save.",
      );

      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_123", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
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
      mockGetDeployStatus
        .mockResolvedValueOnce({ status: "incomplete" })
        .mockResolvedValueOnce({ status: "complete" });
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("check").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("[x] Create production instance");
      expect(err).toContain("[ ] Configure DNS records");
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

    test("plain deploy can skip DNS verification and continue configuring production", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);
      mockLiveProduction({
        instanceId: "ins_prod_123",
        productionConfig: {},
      });
      mockGetDeployStatus.mockResolvedValue({ status: "incomplete" });
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
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
      expect(mockGetDeployStatus).toHaveBeenCalledTimes(1);
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_123", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("DNS handoff reports plain deploy for later continuation", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      const err = stripAnsi(captured.err);
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("run `clerk deploy` again later");
    });

    test("Ctrl-C during OAuth setup reports plain deploy continuation", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      await runDnsHandoff();
      mockSelect.mockRejectedValueOnce(promptExitError());
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }
      expect(error?.message).toContain("Deploy paused at: Google OAuth credential setup");
      expect(error?.message).toContain("Run `clerk deploy` again");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
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
      mockSelect.mockResolvedValueOnce("check").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetDeployStatus.mockReset();
      mockGetDeployStatus
        .mockResolvedValueOnce({ status: "incomplete" })
        .mockResolvedValueOnce({ status: "complete" });

      await runDeploy({});

      const err = stripAnsi(captured.err);
      expect(captured.err).toContain("\x1b[1mConfigure OAuth credentials for production\x1b[0m");
      expect(err).toContain("Configure Google OAuth for production");
      expect(err).toContain(
        "Production Google sign-in requires custom OAuth credentials from Google Cloud Console.",
      );
      expect(err).toContain(
        "Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google",
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
      expect(err).toContain("[x] Configure DNS records");
      expect(err).toContain("No deploy actions remain.");
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("custom-domain DNS setup can pause and later resume", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      mockLiveProduction();
      expect(stripAnsi(captured.err)).toContain("Check the Domains section in the Clerk Dashboard");

      captured = captureLog();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("check").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetDeployStatus.mockReset();
      mockGetDeployStatus
        .mockResolvedValueOnce({ status: "incomplete" })
        .mockResolvedValueOnce({ status: "complete" });

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

      await runDeploy({});
      const pausedErr = stripAnsi(captured.err);
      expect(pausedErr).toContain("Deploy paused");
      expect(pausedErr).toContain("Run `clerk deploy` again");

      captured = captureLog();
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
      // Proceed → create prod → continue after DNS → enter google creds → skip github.
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials").mockResolvedValueOnce("skip");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});
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
      captured = captureLog();
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
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("skip").mockResolvedValueOnce("have-credentials");
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});
      mockGetDeployStatus.mockResolvedValue({ status: "incomplete" });

      await runDeploy({});
      const err = stripAnsi(captured.err);
      expect(err).toContain("DNS propagation can take time");
      expect(err.match(/Add the following records at your DNS provider:/g)).toHaveLength(2);
      expect(err).toContain("Host:  clerk.example.com");
      expect(err).toContain("Value: frontend-api.clerk.services");
      expect(err).toContain("Skipping DNS verification for now.");
      expect(err).toContain("Saved Google OAuth credentials");
      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_mock", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("warns about enabled OAuth providers not yet supported by clerk deploy", async () => {
      await linkedProject();
      mockHumanFlow();
      mockFetchInstanceConfig.mockResolvedValueOnce({
        connection_oauth_google: { enabled: true },
        connection_oauth_discord: { enabled: true },
        connection_oauth_facebook: { enabled: true },
      });

      await runDeploy({});
      const err = stripAnsi(captured.err);

      expect(err).toContain("Configure Google OAuth credentials");
      expect(err).toContain("not yet supported by `clerk deploy`");
      expect(err).toContain("discord");
      expect(err).toContain("facebook");
      expect(err).toContain("Configure them from the Clerk Dashboard before going live");
    });
  });
});
