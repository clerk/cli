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
  // shared.ts (imported by list.ts for instanceLabel) pulls these from config.ts,
  // so the mock must provide them or the real module's named exports go missing.
  INSTANCE_ALIASES: {
    dev: "development",
    development: "development",
    prod: "production",
    production: "production",
  },
  isPrimaryInstance: (i: { branch_name?: string; parent_instance_id?: string }) =>
    !i.branch_name && !i.parent_instance_id,
}));

const { branchList } = await import("./list.ts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

const devOnlyApp = {
  ...mockAppWithBranches,
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      publishable_key: "pk_test_aaa",
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
    test("outputs flat branches and trunks arrays, with active_instance_id", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      expect(parsed.branches).toHaveLength(2);
      expect(parsed.branches[0].branch_name).toBe("feature-auth");
      expect(parsed.branches[0].instance_id).toBe("ins_branch1");
      // Branches are flat and link to their trunk via parent_instance_id.
      expect(parsed.branches[0].parent_instance_id).toBe("ins_dev");
      expect(parsed.branches[1].branch_name).toBe("fix-email");
      expect(parsed.branches[0].created_at).toBe(mockAppWithBranches.instances[2]!.created_at);
      // Bootstrap flows hand the frontend its pk without a second API call.
      expect(parsed.branches[0].publishable_key).toBe("pk_test_ccc");
      expect(parsed.active_instance_id).toBeNull();
      expect(parsed.active_instance_missing).toBe(false);
      // No human table on stdout in JSON/agent mode.
      expect(tableOut()).toBe("");
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

    test("excludes instances without a branch_name", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      for (const b of parsed.branches) {
        expect(b.branch_name).toBeDefined();
        expect(b.instance_id).not.toBe("ins_dev");
        expect(b.instance_id).not.toBe("ins_prod");
      }
    });

    test("outputs the trunk instances with an empty branches array when none exist", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(devOnlyApp);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      expect(parsed.branches).toEqual([]);
      expect(parsed.trunks.map((t: { instance_id: string }) => t.instance_id)).toEqual(["ins_dev"]);
    });

    test("lists the trunk instances development-first with their ids", async () => {
      mockIsAgent.mockReturnValue(true);
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const parsed = JSON.parse(captured.out);
      expect(parsed.trunks).toEqual([
        {
          environment_type: "development",
          instance_id: "ins_dev",
          publishable_key: "pk_test_aaa",
          created_at: null,
        },
        {
          environment_type: "production",
          instance_id: "ins_prod",
          publishable_key: "pk_live_bbb",
          created_at: null,
        },
      ]);
    });
  });

  describe("human table output", () => {
    test("renders a headered table with branch name, instance id, and count", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const out = tableOut();
      expect(out).toContain("BRANCH");
      expect(out).toContain("INSTANCE ID");
      // Parentage is shown via tree nesting now, not a PARENT column.
      expect(out).not.toContain("PARENT");
      expect(out).toContain("feature-auth");
      expect(out).toContain("ins_branch1");
      expect(out).toContain("fix-email");
      expect(out).toContain("2 branches");
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

    test("groups every branch under the Development root row", async () => {
      mockFetchApplication.mockResolvedValue(mockAppWithBranches);

      await branchList({});

      const lines = tableOut().split("\n");
      const devIdx = lines.findIndex((l) => l.includes("Development"));
      const featIdx = lines.findIndex((l) => l.includes("feature-auth"));
      const prodIdx = lines.findIndex((l) => l.includes("Production"));
      const fixIdx = lines.findIndex((l) => l.includes("fix-email"));

      // Trunk header rows are title-cased and carry the environment root's id,
      // not a horizontal rule.
      expect(devIdx).toBeGreaterThanOrEqual(0);
      expect(prodIdx).toBeGreaterThanOrEqual(0);
      expect(lines[devIdx]).toContain("ins_dev");
      expect(lines[prodIdx]).toContain("ins_prod");
      // Branches always fork the development root, so both sit under Development
      // and above the Production root; Production never carries a fork.
      expect(featIdx).toBeGreaterThan(devIdx);
      expect(fixIdx).toBeGreaterThan(devIdx);
      expect(featIdx).toBeLessThan(prodIdx);
      expect(fixIdx).toBeLessThan(prodIdx);
      // Branches are drawn as forks of the root with box-drawing glyphs; the
      // last fork closes with └.
      expect(lines[fixIdx]).toContain("└");
    });

    test("draws ├ for all but the last fork in a section", async () => {
      mockFetchApplication.mockResolvedValue({
        ...mockAppWithBranches,
        instances: [
          mockAppWithBranches.instances[0], // dev root
          mockAppWithBranches.instances[2], // feature-auth under dev
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
      // First of two branches uses ├; the last uses └.
      expect(lines.find((l) => l.includes("feature-auth"))).toContain("├");
      expect(lines.find((l) => l.includes("agent-pr-99"))).toContain("└");
    });

    test("always lists both trunk rows, and Production never gets a placeholder", async () => {
      mockFetchApplication.mockResolvedValue({
        ...mockAppWithBranches,
        instances: [
          mockAppWithBranches.instances[0], // dev root
          mockAppWithBranches.instances[1], // prod root
          mockAppWithBranches.instances[2], // feature-auth under dev
        ],
      });

      await branchList({});

      const lines = tableOut().split("\n");
      // Production has no branches, but its trunk row is still shown for reference.
      const out = lines.join("\n");
      expect(out).toContain("Development");
      expect(out).toContain("Production");
      expect(out).toContain("feature-auth");
      // Production can never hold forks, so it stands alone with no placeholder;
      // Development already has feature-auth, so it has none either.
      expect(out).not.toContain("No branches");
      const prodIdx = lines.findIndex((l) => l.includes("Production"));
      expect(lines[prodIdx + 1] ?? "").not.toContain("No branches");
    });

    test("lists the trunk rows and a note when no branches exist", async () => {
      mockFetchApplication.mockResolvedValue(devOnlyApp);

      await branchList({});

      const lines = tableOut().split("\n");
      const out = lines.join("\n");
      // The dev trunk is still referenced; a note replaces a branch count.
      expect(out).toContain("Development");
      expect(out).toContain("ins_dev");
      expect(out).toContain("No branches yet.");
      // The bare dev trunk also gets an inline "No branches" placeholder row.
      const devIdx = lines.findIndex((l) => l.includes("Development"));
      expect(lines[devIdx + 1]).toContain("No branches");
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
