import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import {
  capturedOutput,
  configStubs,
  credentialStoreStubs,
  promptsStubs,
} from "../../test/stubs.ts";

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

const mockGetToken = mock();
mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockResolveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
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

const { deploy } = await import("./index.ts");

const mockProfile = {
  path: "github.com/org/repo",
  profile: { workspaceId: "", appId: "app_xyz789", instances: { development: "ins_dev" } },
  resolvedVia: "remote" as const,
};

describe("deploy", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockGetToken.mockReset();
    mockResolveProfile.mockReset();
    mockSelect.mockReset();
    mockInput.mockReset();
    mockConfirm.mockReset();
    mockPassword.mockReset();
    consoleSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs structured TOON with pre-flight checks", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockResolveProfile.mockResolvedValue(mockProfile);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const output = capturedOutput(consoleSpy);
      expect(output).toContain("command: deploy");
      expect(output).toContain("authenticated");
      expect(output).toContain("production_instance");
    });

    test("reports unauthenticated when no token", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue(null);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const output = capturedOutput(consoleSpy);
      expect(output).toContain("authenticated");
      expect(output).toContain("false");
      expect(output).toContain("clerk auth login");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockResolveProfile.mockResolvedValue(mockProfile);
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
      mockGetToken.mockResolvedValue("token");
      mockResolveProfile.mockResolvedValue(mockProfile);
      // Domain selection → OAuth credential choice
      mockSelect.mockResolvedValueOnce("clerk-subdomain").mockResolvedValueOnce("have-credentials");
      mockInput.mockResolvedValueOnce("fake-client-id-12345");
      mockPassword.mockResolvedValueOnce("fake-secret");
    }

    test("does not print agent markdown", async () => {
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const allOutput = capturedOutput(consoleSpy);
      expect(allOutput).not.toContain("## deploy\n");
    });

    test("shows mock banner", async () => {
      mockHumanFlow();
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await deploy({});

      const allOutput = capturedOutput(consoleSpy);
      expect(allOutput).toContain("[mock]");
    });
  });
});
