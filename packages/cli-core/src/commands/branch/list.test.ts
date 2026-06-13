import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog } from "../../test/lib/stubs.ts";

const mockFetchApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  PlapiError: class PlapiError extends Error {},
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

mock.module("../../lib/config.ts", () => ({
  resolveAppContext: async () => ({
    appId: "app_test123",
    appLabel: "Test App",
    instanceId: "ins_dev",
    instanceLabel: "development",
  }),
}));

const { branchList } = await import("./list.ts");

const mockAppWithBranches = {
  application_id: "app_test123",
  name: "Test App",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_test_aaa",
    },
    {
      instance_id: "ins_prod",
      environment_type: "production",
      publishable_key: "pk_live_bbb",
    },
    {
      instance_id: "ins_branch1",
      environment_type: "development",
      publishable_key: "pk_test_ccc",
      branch_name: "feature-auth",
      parent_instance_id: "ins_dev",
    },
    {
      instance_id: "ins_branch2",
      environment_type: "development",
      publishable_key: "pk_test_ddd",
      branch_name: "fix-email",
      parent_instance_id: "ins_dev",
    },
  ],
};

describe("branch list", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockFetchApplication.mockReset();
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function runList(options: Parameters<typeof branchList>[0] = {}) {
    return captured.run(() => branchList(options));
  }

  describe("agent mode JSON output", () => {
    test("outputs JSON with only branch instances", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await runList();

      const parsed = JSON.parse(captured.out);
      expect(parsed.branches).toHaveLength(2);
      expect(parsed.branches[0].branch_name).toBe("feature-auth");
      expect(parsed.branches[0].instance_id).toBe("ins_branch1");
      expect(parsed.branches[0].parent_instance_id).toBe("ins_dev");
      expect(parsed.branches[1].branch_name).toBe("fix-email");
    });

    test("excludes instances without branch_name", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await runList();

      const parsed = JSON.parse(captured.out);
      // Should only include the 2 branch instances, not dev or prod
      for (const b of parsed.branches) {
        expect(b.branch_name).toBeDefined();
        expect(b.instance_id).not.toBe("ins_dev");
        expect(b.instance_id).not.toBe("ins_prod");
      }
    });

    test("outputs empty branches array when no branches exist", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue({
        ...mockAppWithBranches,
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_aaa",
          },
        ],
      });

      await runList();

      const parsed = JSON.parse(captured.out);
      expect(parsed.branches).toEqual([]);
    });
  });

  describe("human mode output", () => {
    test("prints branch name and instance id to stdout", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await runList();

      expect(captured.out).toContain("feature-auth");
      expect(captured.out).toContain("ins_branch1");
      expect(captured.out).toContain("fix-email");
      expect(captured.out).toContain("ins_branch2");
    });

    test("shows info message when no branches exist", async () => {
      mockFetchApplication.mockResolvedValue({
        ...mockAppWithBranches,
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_aaa",
          },
        ],
      });

      await runList();

      expect(captured.err).toContain("No branches.");
    });
  });
});
