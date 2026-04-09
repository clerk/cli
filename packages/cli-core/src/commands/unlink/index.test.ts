import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog, configStubs, gitStubs, promptsStubs } from "../../test/lib/stubs.ts";

const mockIsAgent = mock();
const mockIsHuman = mock();
let _modeOverride: string | undefined;
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride === "agent" : mockIsAgent(...args),
  isHuman: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride !== "agent" : mockIsHuman(...args),
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
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockIsHuman.mockReset();
    mockResolveProfile.mockReset();
    mockRemoveProfile.mockReset();
    mockGetGitRepoRoot.mockReset();
    mockGetGitRepoRoot.mockResolvedValue("/repo");
    mockConfirm.mockReset();
    consoleSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  function runUnlink(options?: Parameters<typeof unlink>[0]) {
    return captured.run(() => unlink(options));
  }

  describe("agent mode", () => {
    test("outputs prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runUnlink();

      expect(captured.out).toContain("unlinking a Clerk application");
    });

    test("does not trigger side effects", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runUnlink();

      expect(mockResolveProfile).not.toHaveBeenCalled();
      expect(mockRemoveProfile).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe("not linked", () => {
    test("exits when directory is not linked", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue(undefined);
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      await expect(runUnlink()).rejects.toThrow("not linked");
    });
  });

  describe("confirmation", () => {
    test("skips confirm with --yes", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockRemoveProfile.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runUnlink({ yes: true });

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

      await runUnlink();

      expect(mockConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("/repo") }),
      );
      expect(mockRemoveProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("aborts when user declines", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await expect(runUnlink()).rejects.toThrow("User aborted");
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

      await runUnlink({ yes: true });

      expect(captured.out).toContain("Unlinked");
    });
  });
});
