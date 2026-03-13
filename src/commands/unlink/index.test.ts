import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { capturedOutput, configStubs, gitStubs, promptsStubs } from "../../test/stubs.ts";

const mockIsAgent = mock();
const mockIsHuman = mock();
let _modeOverride: string | undefined;
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride === "agent" : mockIsAgent(...args),
  isHuman: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride !== "agent" : mockIsHuman(...args),
  isJSON: () => (_modeOverride !== undefined ? _modeOverride === "agent" : mockIsAgent()),
  setMode: (m: string) => {
    _modeOverride = m;
  },
  getMode: () => _modeOverride ?? "human",
}));

const mockResolveProfile = mock();
const mockRemoveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  removeProfile: (...args: unknown[]) => mockRemoveProfile(...args),
}));

const mockGetGitRepoRoot = mock();
mock.module("../../lib/git.ts", () => ({
  ...gitStubs,
  getGitRepoRoot: (...args: unknown[]) => mockGetGitRepoRoot(...args),
}));

const mockConfirm = mock();
mock.module("@inquirer/prompts", () => ({
  ...promptsStubs,
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { unlink } = await import("./index.ts");

const mockProfile = {
  path: process.cwd(),
  profile: { workspaceId: "", appId: "app_123", instances: { development: "ins_dev" } },
};

describe("unlink", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockIsHuman.mockReset();
    mockResolveProfile.mockReset();
    mockRemoveProfile.mockReset();
    mockGetGitRepoRoot.mockReset();
    mockGetGitRepoRoot.mockResolvedValue("/repo");
    mockConfirm.mockReset();
    consoleSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs structured JSON with check results", async () => {
      mockIsAgent.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink({ yes: true });

      const jsonLine = consoleSpy.mock.calls.find((c: unknown[]) => {
        try {
          JSON.parse(c[0] as string);
          return true;
        } catch {
          return false;
        }
      });
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine![0] as string);
      expect(parsed.command).toBe("unlink");
      expect(parsed.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "linked", ok: true }),
          expect.objectContaining({ name: "unlinked", ok: true }),
        ]),
      );
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink({ yes: true });

      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe("not linked", () => {
    test("throws in human mode when not linked", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await expect(unlink()).rejects.toThrow("not linked");
    });

    test("reports not linked and returns in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);
      mockIsHuman.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink();

      const output = capturedOutput(consoleSpy);
      expect(output).toContain("not linked");
    });
  });

  describe("confirmation", () => {
    test("skips confirm with --yes", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink({ yes: true });

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockRemoveProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("removes profile when user confirms", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockConfirm.mockResolvedValue(true);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink();

      expect(mockConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("/repo") }),
      );
      expect(mockRemoveProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("throws UserAbortError when user declines", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await expect(unlink()).rejects.toThrow("User aborted");

      expect(mockRemoveProfile).not.toHaveBeenCalled();
    });
  });

  describe("output", () => {
    test("logs confirmation message", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink({ yes: true });

      const output = capturedOutput(consoleSpy);
      expect(output).toContain("Unlinked");
    });
  });
});
