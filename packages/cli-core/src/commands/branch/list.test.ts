import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureUi, useCaptureLog } from "../../test/lib/stubs.ts";

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

const mockGetActiveInstanceForApp = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: async () => ({
    appId: "app_test123",
    appLabel: "Test App",
    instanceId: "ins_dev",
    instanceLabel: "development",
  }),
  getActiveInstanceForApp: (...a: unknown[]) => mockGetActiveInstanceForApp(...a),
  // shared.ts (imported by list.ts) pulls these from config.ts, so the mock must
  // provide them or the real module's named exports go missing. A root is the
  // null-parent instance (ADR-0003), so `main` (branch_name set, no parent) is a
  // root.
  INSTANCE_ALIASES: {
    dev: "development",
    development: "development",
    prod: "production",
    production: "production",
  },
  isPrimaryInstance: (i: { parent_instance_id?: string }) => !i.parent_instance_id,
}));

const { branchList } = await import("./list.ts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// An enabled app: the dev root carries the real `main` branch name, forks hang
// off it, and production has no branch identity.
const mockAppWithBranches = {
  application_id: "app_test123",
  name: "Test App",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_test_aaa",
      branch_name: "main",
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
      created_at: Date.now() - 3 * DAY,
    },
    {
      instance_id: "ins_branch2",
      environment_type: "development",
      publishable_key: "pk_test_ddd",
      branch_name: "fix-email",
      parent_instance_id: "ins_dev",
      created_at: Date.now() - 2 * HOUR,
    },
  ],
};

// A branching-enabled app with only the `main` branch (no forks yet).
const mainOnlyApp = {
  ...mockAppWithBranches,
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_test_aaa",
      branch_name: "main",
    },
  ],
};

describe("branch list", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let uiCapture: ReturnType<typeof captureUi>;
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    uiCapture = captureUi();
    uiCapture.install();
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    uiCapture.teardown();
    mockFetchApplication.mockReset();
    mockIsAgent.mockReset();
    mockGetActiveInstanceForApp.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // The human table is rendered via `ui` (stderr); `--json` uses log.data (stdout).
  const tableOut = () => uiCapture.out;

  describe("JSON output", () => {
    test("outputs a single branches list with main first and active_instance_id", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      // A single branches list: main (null-parent) first, then its forks.
      expect(parsed.trunks).toBeUndefined();
      expect(parsed.branches).toHaveLength(3);
      expect(parsed.branches[0].branch_name).toBe("main");
      expect(parsed.branches[0].instance_id).toBe("ins_dev");
      expect(parsed.branches[0].parent_instance_id).toBeNull();
      expect(parsed.branches[1].branch_name).toBe("feature-auth");
      expect(parsed.branches[1].instance_id).toBe("ins_branch1");
      // Forks link to main via parent_instance_id.
      expect(parsed.branches[1].parent_instance_id).toBe("ins_dev");
      expect(parsed.branches[2].branch_name).toBe("fix-email");
      expect(parsed.branches[1].created_at).toBe(mockAppWithBranches.instances[2]!.created_at);
      // Bootstrap flows hand the frontend its pk without a second API call.
      expect(parsed.branches[1].publishable_key).toBe("pk_test_ccc");
      expect(parsed.active_instance_id).toBeNull();
      expect(parsed.active_instance_missing).toBe(false);
      // No human table on stdout in JSON/agent mode.
      expect(tableOut()).toBe("");
    });

    test("excludes production from the branches list", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      for (const b of parsed.branches) {
        expect(b.branch_name).toBeDefined();
        expect(b.instance_id).not.toBe("ins_prod");
      }
    });

    test("flags a dangling active pointer in JSON", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_gone",
        label: "tmp/stale",
        environmentType: "development",
      });

      await branchList({ json: true });

      const parsed = JSON.parse(captured.out);
      expect(parsed.active_instance_id).toBe("ins_gone");
      expect(parsed.active_instance_missing).toBe(true);
    });

    test("reports the active instance id in JSON", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_branch1",
        label: "feature-auth",
        environmentType: "development",
      });

      await branchList({ json: true });

      const parsed = JSON.parse(captured.out);
      expect(parsed.active_instance_id).toBe("ins_branch1");
    });

    test("returns just main when no forks exist", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mainOnlyApp);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      expect(parsed.branches).toHaveLength(1);
      expect(parsed.branches[0].branch_name).toBe("main");
      expect(parsed.branches[0].parent_instance_id).toBeNull();
    });
  });

  describe("human table output", () => {
    test("renders a headered tree with main pinned above its forks and no production", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const out = tableOut();
      expect(out).toContain("BRANCH");
      expect(out).toContain("INSTANCE ID");
      // Parentage is shown via tree nesting, not a PARENT column.
      expect(out).not.toContain("PARENT");
      // Production has no branch identity and never appears.
      expect(out).not.toContain("Production");
      expect(out).not.toContain("ins_prod");
      expect(out).toContain("main");
      expect(out).toContain("feature-auth");
      expect(out).toContain("ins_branch1");
      expect(out).toContain("fix-email");
      expect(out).toContain("3 branches");
      // Human table goes to stderr (ui), never to the pipeable stdout stream.
      expect(captured.out).toBe("");
    });

    test("renders a CREATED column with relative ages", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const lines = tableOut().split("\n");
      expect(lines.find((l) => l.includes("CREATED"))).toBeDefined();
      // feature-auth was created 3 days ago; fix-email 2 hours ago.
      expect(lines.find((l) => l.includes("feature-auth"))).toContain("3d ago");
      expect(lines.find((l) => l.includes("fix-email"))).toContain("2h ago");
    });

    test("pins main at the top with forks nested beneath it", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const lines = tableOut().split("\n");
      const mainIdx = lines.findIndex((l) => l.includes("main"));
      const featIdx = lines.findIndex((l) => l.includes("feature-auth"));
      const fixIdx = lines.findIndex((l) => l.includes("fix-email"));

      // main is pinned first (carrying its own instance id) and forks follow.
      expect(mainIdx).toBeGreaterThanOrEqual(0);
      expect(lines[mainIdx]).toContain("ins_dev");
      expect(featIdx).toBeGreaterThan(mainIdx);
      expect(fixIdx).toBeGreaterThan(mainIdx);
      // Forks are drawn as a box-drawing tree; the last fork closes with └.
      expect(lines[fixIdx]).toContain("└");
    });

    test("draws ├ for all but the last fork", async () => {
      mockFetchApplication.mockResolvedValue({
        ...mockAppWithBranches,
        instances: [
          mockAppWithBranches.instances[0], // main (dev root)
          mockAppWithBranches.instances[2], // feature-auth
          {
            instance_id: "ins_branch3",
            environment_type: "development",
            publishable_key: "pk_test_eee",
            branch_name: "agent-pr-99",
            parent_instance_id: "ins_dev",
            created_at: Date.now() - HOUR,
          },
        ],
      });

      await branchList({});

      const lines = tableOut().split("\n");
      // First of two forks uses ├; the last uses └.
      expect(lines.find((l) => l.includes("feature-auth"))).toContain("├");
      expect(lines.find((l) => l.includes("agent-pr-99"))).toContain("└");
    });

    test("shows main with a note when no forks exist", async () => {
      mockFetchApplication.mockResolvedValue(mainOnlyApp);

      await branchList({});

      const lines = tableOut().split("\n");
      const out = lines.join("\n");
      expect(out).toContain("main");
      expect(out).toContain("ins_dev");
      // main alone is a single branch.
      expect(out).toContain("1 branch");
    });

    test("shows a bare note when branching is not enabled (nameless dev root)", async () => {
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

      await branchList({});

      const out = tableOut();
      expect(out).toContain("No branches yet.");
      expect(out).not.toContain("BRANCH");
    });

    test("marks the active branch with ● and leaves others unmarked", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_branch1",
        label: "feature-auth",
        environmentType: "development",
      });

      await branchList({});

      // Color codes can sit between the marker and the name, so assert per-line.
      const lines = tableOut().split("\n");
      const activeLine = lines.find((l) => l.includes("feature-auth"));
      const inactiveLine = lines.find((l) => l.includes("fix-email"));
      expect(activeLine).toContain("●");
      expect(inactiveLine).not.toContain("●");
    });

    test("marks main active when it is the active instance", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_dev",
        label: "main",
        branch_name: "main",
        environmentType: "development",
      });

      await branchList({});

      const lines = tableOut().split("\n");
      const mainLine = lines.find((l) => l.includes("main"));
      expect(mainLine).toContain("●");
    });

    test("marks no branch when the active pointer is out of app", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      // The cross-app guard lives inside getActiveInstanceForApp (covered in
      // config.test.ts); an out-of-app pointer resolves to undefined here.
      mockGetActiveInstanceForApp.mockResolvedValue(undefined);

      await branchList({});

      expect(tableOut()).not.toContain("●");
    });

    test("warns when the active pointer targets a deleted instance", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_gone",
        label: "tmp/stale",
        environmentType: "development",
      });

      await branchList({});

      const out = tableOut();
      expect(out).not.toContain("●");
      expect(out).toContain("Active instance `tmp/stale` (ins_gone) is not in this app anymore.");
      expect(out).toContain("Run `clerk switch` to re-point this worktree.");
    });

    test("does not warn when the active pointer is healthy", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);
      mockGetActiveInstanceForApp.mockResolvedValue({
        appId: "app_test123",
        instanceId: "ins_branch1",
        label: "feature-auth",
        environmentType: "development",
      });

      await branchList({});

      expect(tableOut()).not.toContain("is not in this app anymore");
    });
  });
});
