import { test, expect, describe, mock } from "bun:test";
import { unlink } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const linkedProfile = {
  path: process.cwd(),
  profile: { workspaceId: "", appId: "app_123", instances: { development: "ins_dev" } },
};

describe("unlink", () => {
  describe("agent mode", () => {
    test("outputs prompt and returns without side effects", async () => {
      const deps = testRoot({
        mode: { isAgent: () => true, isHuman: () => false },
      });

      await unlink(deps);

      expect(deps.log.data).toHaveBeenCalledTimes(1);
      const output = (deps.log.data as ReturnType<typeof mock>).mock.calls[0]![0] as string;
      expect(output).toContain("unlinking a Clerk application");
      expect(deps.configStore.resolveProfile).not.toHaveBeenCalled();
      expect(deps.configStore.removeProfile).not.toHaveBeenCalled();
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
    });
  });

  describe("not linked", () => {
    test("throws when directory is not linked", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: { resolveProfile: async () => undefined },
      });

      await expect(unlink(deps)).rejects.toThrow("not linked");
    });
  });

  describe("confirmation", () => {
    test("skips confirm with --yes", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => "/repo" },
      });

      await unlink(deps, { yes: true });

      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.configStore.removeProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("removes profile when user confirms", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => "/repo" },
        prompts: { confirm: async () => true },
      });

      await unlink(deps);

      expect(deps.prompts.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("/repo") }),
      );
      expect(deps.configStore.removeProfile).toHaveBeenCalledWith(process.cwd());
    });

    test("aborts when user declines", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => "/repo" },
        prompts: { confirm: async () => false },
      });

      await expect(unlink(deps)).rejects.toThrow("User aborted");
      expect(deps.configStore.removeProfile).not.toHaveBeenCalled();
    });

    test("skips confirm prompt in agent (non-human) mode even without --yes", async () => {
      // isHuman() === false skips the confirmation gate.
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => false },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => "/repo" },
      });

      await unlink(deps);

      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.configStore.removeProfile).toHaveBeenCalled();
    });
  });

  describe("output", () => {
    test("logs confirmation message via deps.log.info", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => "/repo" },
      });

      await unlink(deps, { yes: true });

      const logCalls = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const message = logCalls.find((m: string) => m.includes("Unlinked"));
      expect(message).toBeDefined();
      expect(message).toContain("/repo");
    });

    test("falls back to existing.path when no git repo", async () => {
      const deps = testRoot({
        mode: { isAgent: () => false, isHuman: () => true },
        configStore: {
          resolveProfile: async () => linkedProfile,
          removeProfile: async () => {},
        },
        git: { getGitRepoRoot: async () => undefined },
      });

      await unlink(deps, { yes: true });

      expect(deps.configStore.removeProfile).toHaveBeenCalledWith(process.cwd());
    });
  });
});
