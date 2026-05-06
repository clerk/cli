import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { captureLog, promptsStubs, listageStubs } from "../../test/lib/stubs.ts";
import { EXIT_CODE, UserAbortError, type CliError } from "../../lib/errors.ts";

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
}));

mock.module("./api.ts", () => ({
  createProductionInstance: (...args: unknown[]) => mockCreateProductionInstance(...args),
  validateCloning: (...args: unknown[]) => mockValidateCloning(...args),
  getDeployStatus: (...args: unknown[]) => mockGetDeployStatus(...args),
  retryApplicationDomainSSL: (...args: unknown[]) => mockRetrySSL(...args),
  retryApplicationDomainMail: (...args: unknown[]) => mockRetryMail(...args),
  domainConnectUrl: (...args: unknown[]) => mockDomainConnectUrl(...args),
  patchInstanceConfig: (...args: unknown[]) => mockPatchInstanceConfig(...args),
}));

mock.module("../../lib/sleep.ts", () => ({
  sleep: () => Promise.resolve(),
}));

const { _setConfigDir, readConfig, setProfile } = await import("../../lib/config.ts");
const { deploy } = await import("./index.ts");

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

  async function linkedProject(profile: Record<string, unknown> = {}) {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-deploy-test-"));
    _setConfigDir(tempDir);
    await setProfile(process.cwd(), {
      workspaceId: "workspace_123",
      appId: "app_xyz789",
      appName: "my-saas-app",
      instances: { development: "ins_dev_123" },
      ...profile,
    } as never);
  }

  describe("agent mode", () => {
    test("outputs deploy prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      expect(captured.out).toContain("deploying a Clerk application to production");
    });

    test("prompt includes all deployment steps", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const output = captured.out;
      expect(output).toContain("Prerequisites");
      expect(output).toContain("Validate Cloning");
      expect(output).toContain("Discover enabled OAuth providers");
      expect(output).toContain("Create the Production Instance");
      expect(output).toContain("Configure Social OAuth Providers");
      expect(output).toContain("Finalize");
    });

    test("prompt includes API reference for new deploy lifecycle endpoints", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const output = captured.out;
      expect(output).toContain("/v1/platform/applications");
      expect(output).toContain("validate_cloning");
      expect(output).toContain("production_instance");
      expect(output).toContain("deploy_status");
      expect(output).toContain("ssl_retry");
      expect(output).toContain("mail_retry");
    });

    test("prompt includes OAuth redirect URI pattern", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const output = captured.out;
      expect(output).toContain("accounts.{domain}/v1/oauth_callback");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({ debug: true });

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
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");
    }

    async function runDnsHandoff() {
      mockHumanFlow();
      await runDeploy({});
      captured = captureLog();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
    }

    function mockOAuthCompletion() {
      mockConfirm.mockResolvedValueOnce(true);
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
      expect(err).toContain("Create production instance");
      expect(err).toContain("Configure Google OAuth credentials");
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
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Cancelled");
      expect(terminalOutput).toContain("\x1b[31m└");
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
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
      expect(config.profiles[process.cwd()]?.instances.production).toBeUndefined();
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Cancelled");
      expect(terminalOutput).toContain("\x1b[31m└");
      expect(terminalOutput).not.toContain("Done");
    });

    test("prints production next steps after successful deploy", async () => {
      await linkedProject();
      await runDnsHandoff();
      mockOAuthCompletion();

      await runDeploy({ continue: true });
      const err = stripAnsi(captured.err);

      expect(err).toContain("Next steps");
      expect(err).toContain("clerk env pull --instance prod");
      expect(err).toContain("Update env vars on your hosting provider");
      expect(err).toContain("Production keys only work on your production domain");
    });

    test("DNS setup prints dashboard handoff and asks before continuing", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      const err = stripAnsi(captured.err);
      const config = await readConfig();

      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        pending: { type: "dns" },
        domain: "example.com",
      });
      expect(err).toContain("Add the following records at your DNS provider");
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("propagation and SSL issuance");
      expect(err).toContain("clerk deploy --continue");
      expect(err).toContain("clerk deploy --abort");
      expect(mockConfirm).toHaveBeenCalledTimes(2);
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

    test("Ctrl-C at the DNS handoff saves state and reports paused", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockRejectedValueOnce(promptExitError());
      mockInput.mockResolvedValueOnce("example.com");
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        appId: "app_xyz789",
        developmentInstanceId: "ins_dev_123",
        productionInstanceId: "ins_prod_mock",
        domain: "example.com",
        pending: { type: "dns" },
      });
      expect(error?.message).toContain("Deploy paused at: DNS verification");
      expect(error?.message).toContain("clerk deploy --continue");
      expect(error?.message).toContain("clerk deploy --abort");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).toContain("\x1b[33m└");
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
      await runDeploy({ continue: true });
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
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_apple",
          domain: "example.com",
          pending: { type: "oauth", provider: "apple" },
          oauthProviders: ["apple"],
          completedOAuthProviders: [],
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

      await runDeploy({ continue: true });

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
      await runDeploy({ continue: true });

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

    test("plain deploy errors when a production instance is already linked", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
      });
      mockIsAgent.mockReturnValue(false);

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }

      expect(error?.message).toContain("This app already has a production instance configured");
      expect(error?.message).toContain("clerk env pull --instance prod");
      expect(error?.message).toContain("clerk deploy --continue");
      expect(mockInput).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
    });

    test("plain deploy errors while a deploy operation is paused", async () => {
      await linkedProject({
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_123",
          domain: "example.com",
          pending: { type: "dns" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);

      let error: CliError | undefined;
      try {
        await runDeploy({});
      } catch (caught) {
        error = caught as CliError;
      }

      expect(error?.message).toContain("There is an active deploy in progress");
      expect(error?.message).toContain("Use `clerk deploy --continue`");
      expect(error?.message).toContain("DNS verification");
      expect(error?.exitCode).toBe(EXIT_CODE.GENERAL);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("DNS handoff saves DNS state and reports --continue", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});
      const err = stripAnsi(captured.err);

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        appId: "app_xyz789",
        developmentInstanceId: "ins_dev_123",
        productionInstanceId: "ins_prod_mock",
        domain: "example.com",
        pending: { type: "dns" },
      });
      expect(err).toContain("Check the Domains section in the Clerk Dashboard");
      expect(err).toContain("clerk deploy --continue");
    });

    test("Ctrl-C during OAuth setup saves provider state and reports --continue", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      await runDnsHandoff();
      mockConfirm.mockRejectedValueOnce(promptExitError());
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      let error: CliError | undefined;
      try {
        await runDeploy({ continue: true });
      } catch (caught) {
        error = caught as CliError;
      }

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        appId: "app_xyz789",
        developmentInstanceId: "ins_dev_123",
        productionInstanceId: "ins_prod_mock",
        domain: "example.com",
        pending: { type: "oauth", provider: "google" },
      });
      expect(error?.message).toContain("Deploy paused at: Google OAuth credential setup");
      expect(error?.message).toContain("clerk deploy --continue");
      expect(error?.message).toContain("clerk deploy --abort");
      expect(error?.exitCode).toBe(EXIT_CODE.SIGINT);
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).toContain("\x1b[33m└");
      expect(terminalOutput).not.toContain("Done");
    });

    test("saves OAuth credentials to the production instance from deploy state", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_created_456" },
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_created_456",
          domain: "example.com",
          pending: { type: "oauth", provider: "google" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({ continue: true });

      expect(mockPatchInstanceConfig).toHaveBeenCalledWith("app_xyz789", "ins_prod_created_456", {
        connection_oauth_google: {
          enabled: true,
          client_id: "google-client-id.apps.googleusercontent.com",
          client_secret: "google-secret",
        },
      });
    });

    test("--continue reports when there is no paused deploy operation", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);

      await runDeploy({ continue: true });

      expect(captured.err).toContain("There is no paused deploy operation");
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("--abort reports when there is no paused deploy operation", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);

      await runDeploy({ abort: true });

      expect(captured.err).toContain("There is no paused deploy operation");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("--abort asks for confirmation and clears paused deploy state", async () => {
      await linkedProject({
        instances: { development: "ins_dev_123", production: "ins_prod_123" },
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_123",
          domain: "example.com",
          pending: { type: "dns" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true);

      await runDeploy({ abort: true });

      const config = await readConfig();
      const err = stripAnsi(captured.err);
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_123");
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "Abort the paused deploy operation?",
        default: false,
      });
      expect(err).toContain("Cleared the paused deploy bookmark");
      expect(err).toContain("does not undo any changes already saved");
      expect(err).not.toContain("rerun `clerk deploy`");
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("--abort keeps paused deploy state when confirmation is declined", async () => {
      await linkedProject({
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_123",
          domain: "example.com",
          pending: { type: "dns" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(false);

      await runDeploy({ abort: true });

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        appId: "app_xyz789",
        domain: "example.com",
        pending: { type: "dns" },
      });
      expect(captured.err).toContain("Paused deploy abort cancelled");
      expect(captured.err).toContain("clerk deploy --continue");
      expect(captured.err).toContain("clerk deploy --abort");
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("rejects --continue and --abort together", async () => {
      await linkedProject({
        deploy: {
          appId: "app_xyz789",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_123",
          domain: "example.com",
          pending: { type: "dns" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);

      await expect(runDeploy({ continue: true, abort: true })).rejects.toThrow(
        "Cannot use --continue and --abort together",
      );
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInput).not.toHaveBeenCalled();
    });

    test("--continue reports invalid paused state with recovery guidance", async () => {
      await linkedProject({
        deploy: {
          appId: "other_app",
          developmentInstanceId: "ins_dev_123",
          productionInstanceId: "ins_prod_123",
          domain: "example.com",
          pending: { type: "dns" },
          oauthProviders: ["google"],
          completedOAuthProviders: [],
        },
      });
      mockIsAgent.mockReturnValue(false);

      await runDeploy({ continue: true });
      const err = stripAnsi(captured.err);

      expect(err).toContain("The paused deploy operation no longer matches this linked project");
      expect(err).toContain(
        "Run `clerk deploy` from the project that started the paused operation",
      );
    });

    test("custom-domain DNS setup can pause and later resume", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockInput.mockResolvedValueOnce("example.com");

      await runDeploy({});

      let config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        appId: "app_xyz789",
        developmentInstanceId: "ins_dev_123",
        productionInstanceId: "ins_prod_mock",
        domain: "example.com",
        pending: { type: "dns" },
      });
      expect(stripAnsi(captured.err)).toContain("Check the Domains section in the Clerk Dashboard");

      captured = captureLog();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({ continue: true });
      const err = stripAnsi(captured.err);

      config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
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
      mockConfirm.mockResolvedValueOnce(false);

      await runDeploy({ continue: true });

      let config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        pending: { type: "oauth", provider: "google" },
        domain: "example.com",
      });
      expect(captured.err).toContain("Deploy paused");
      expect(captured.err).toContain("clerk deploy --continue");
      expect(captured.err).toContain("clerk deploy --abort");

      captured = captureLog();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockPassword.mockResolvedValueOnce("google-secret");

      await runDeploy({ continue: true });
      const err = stripAnsi(captured.err);

      config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
      expect(config.profiles[process.cwd()]?.instances.production).toBe("ins_prod_mock");
      expect(err).toContain("Saved Google OAuth credentials");
      expect(err).toContain("Production ready at https://example.com");
    });

    test("Pausing OAuth mid-loop preserves earlier completed providers in saved state", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockFetchInstanceConfig.mockResolvedValue({
        connection_oauth_google: { enabled: true },
        connection_oauth_github: { enabled: true },
      });
      // Proceed → continue after DNS → setup google now → enter google creds → say no on github.
      mockConfirm
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockInput
        .mockResolvedValueOnce("example.com")
        .mockResolvedValueOnce("google-client-id.apps.googleusercontent.com");
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockPassword.mockResolvedValueOnce("google-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({});

      let config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        pending: { type: "oauth", provider: "github" },
        completedOAuthProviders: ["google"],
        oauthProviders: ["google", "github"],
      });

      // Resume and finish: should not re-prompt for google, should finalize.
      captured = captureLog();
      mockConfirm.mockReset();
      mockSelect.mockReset();
      mockInput.mockReset();
      mockPassword.mockReset();
      mockPatchInstanceConfig.mockReset();
      mockConfirm.mockResolvedValueOnce(true);
      mockSelect.mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("github-client-id");
      mockPassword.mockResolvedValueOnce("github-secret");
      mockPatchInstanceConfig.mockResolvedValueOnce({});

      await runDeploy({ continue: true });
      const err = stripAnsi(captured.err);

      config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toBeUndefined();
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

    test("DNS verification timeout outros as paused, not failed", async () => {
      await linkedProject();
      mockIsAgent.mockReturnValue(false);
      mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      mockInput.mockResolvedValueOnce("example.com");
      mockGetDeployStatus.mockResolvedValue({ status: "incomplete" });
      stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

      await runDeploy({});

      const config = await readConfig();
      expect(config.profiles[process.cwd()]?.deploy).toMatchObject({
        pending: { type: "dns" },
        domain: "example.com",
      });
      const terminalOutput = stderrSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("");
      expect(terminalOutput).toContain("Paused");
      expect(terminalOutput).not.toContain("Failed");
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
