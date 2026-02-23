import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";

const mockIsAgent = mock();

mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
}));

// Mock inquirer prompts so human-mode tests don't hang
const mockSelect = mock();
const mockInput = mock();
const mockConfirm = mock();
const mockPassword = mock();

mock.module("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: (...args: unknown[]) => mockInput(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));

const { deploy } = await import("./index.ts");

describe("deploy", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    mockIsAgent.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
    mockPassword.mockReset();
    consoleSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs deploy prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("deploying a Clerk application to production");
    });

    test("prompt includes all deployment steps", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const output = consoleSpy.mock.calls[0][0] as string;
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

      await deploy({});

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("/v1/platform/applications");
      expect(output).toContain("instances/production/config");
      expect(output).toContain("instances/development/config");
    });

    test("prompt includes OAuth redirect URI pattern", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("accounts.{domain}/v1/oauth_callback");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({ debug: true });

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

      await deploy({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).not.toContain(
        "deploying a Clerk application to production"
      );
    });

    test("shows mock banner", async () => {
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("[mock]");
    });
  });
});
