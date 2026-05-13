import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { useCaptureLog, promptsStubs, listageStubs } from "../../test/lib/stubs.ts";

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

const { deploy } = await import("./index.ts");

describe("deploy", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  afterEach(() => {
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
    mockPassword.mockReset();
    consoleSpy?.mockRestore();
  });

  function runDeploy(options: Parameters<typeof deploy>[0]) {
    return deploy(options);
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
      expect(output).toContain("Verify Subscription Compatibility");
      expect(output).toContain("Choose a Production Domain");
      expect(output).toContain("Create the Production Instance");
      expect(output).toContain("Configure Social OAuth Providers");
      expect(output).toContain("Finalize");
    });

    test("prompt includes API reference", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const output = captured.out;
      expect(output).toContain("/v1/platform/applications");
      expect(output).toContain("instances/production/config");
      expect(output).toContain("instances/development/config");
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
      // Domain selection → OAuth credential choice
      mockSelect.mockResolvedValueOnce("clerk-subdomain").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("fake-client-id-12345");
      mockPassword.mockResolvedValueOnce("fake-secret");
    }

    test("does not print deploy prompt", async () => {
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const allOutput = captured.out;
      expect(allOutput).not.toContain("deploying a Clerk application to production");
    });

    test("shows mock banner", async () => {
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({});

      const allOutput = captured.out;
      expect(allOutput).toContain("[mock]");
    });
  });
});
