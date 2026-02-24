import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";

const mockIsAgent = mock();
const mockIsHuman = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => mockIsHuman(...args),
}));

const mockResolveProfile = mock();
const mockRemoveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  removeProfile: (...args: unknown[]) => mockRemoveProfile(...args),
}));

const mockConfirm = mock();
mock.module("@inquirer/prompts", () => ({
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

  afterEach(() => {
    mockIsAgent.mockReset();
    mockIsHuman.mockReset();
    mockResolveProfile.mockReset();
    mockRemoveProfile.mockReset();
    mockConfirm.mockReset();
    consoleSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("unlinking a Clerk application");
    });

    test("does not trigger side effects", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink();

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
      exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

      await expect(unlink()).rejects.toThrow("exit");

      expect(errorSpy.mock.calls[0][0]).toContain("not linked");
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

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockRemoveProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("aborts when user declines", async () => {
      mockIsAgent.mockReturnValue(false);
      mockIsHuman.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue(mockProfile);
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await unlink();

      expect(mockRemoveProfile).not.toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Aborted");
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

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Unlinked");
    });
  });
});
