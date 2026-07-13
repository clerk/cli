import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveProfile = mock();
const mockGetActiveInstanceForApp = mock();
const mockGetGitCurrentBranch = mock();
const mockFetchApplication = mock();

mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...a: unknown[]) => mockResolveProfile(...a),
  getActiveInstanceForApp: (...a: unknown[]) => mockGetActiveInstanceForApp(...a),
  isPrimaryInstance: (i: { parent_instance_id?: string }) => !i.parent_instance_id,
  instanceLabel: (i: { environment_type: string; branch_name?: string }) =>
    i.branch_name ? `${i.environment_type} ⎇ ${i.branch_name}` : i.environment_type,
}));
mock.module("../../lib/git.ts", () => ({
  getGitCurrentBranch: (...a: unknown[]) => mockGetGitCurrentBranch(...a),
}));
mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...a: unknown[]) => mockFetchApplication(...a),
  PlapiError: class PlapiError extends Error {},
}));
mock.module("../../lib/spinner.ts", () => ({
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  withSpinner: async (_m: string, fn: () => Promise<unknown>) => fn(),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...a: unknown[]) => mockIsAgent(...a),
  isHuman: (...a: unknown[]) => !mockIsAgent(...a),
  setMode: () => {},
  getMode: () => "human",
}));

const { status } = await import("./status.ts");

const APP = {
  application_id: "app_1",
  name: "my-app",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_dev" },
    { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_prod" },
    {
      instance_id: "ins_branch",
      environment_type: "development",
      publishable_key: "pk_b",
      branch_name: "agent/pr-42",
      parent_instance_id: "ins_dev",
    },
  ],
};

describe("clerk status", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockResolveProfile.mockResolvedValue({
      path: "/repo",
      profile: { appId: "app_1", appName: "my-app", instances: { development: "ins_dev" } },
      resolvedVia: "directory",
    });
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_branch",
      label: "agent/pr-42",
      environmentType: "development",
      gitBranch: "agent/pr-42",
    });
    mockGetGitCurrentBranch.mockResolvedValue("agent/pr-42");
    mockFetchApplication.mockResolvedValue(APP);
    mockIsAgent.mockReturnValue(false);
  });

  afterEach(() => {
    for (const m of [
      mockResolveProfile,
      mockGetActiveInstanceForApp,
      mockGetGitCurrentBranch,
      mockFetchApplication,
      mockIsAgent,
    ])
      m.mockReset();
  });

  test("reports the active fork with the glyph label and no annotation", async () => {
    await status({});
    expect(captured.err).toContain("my-app");
    // The glyph label conveys branch-ness, so a fork carries no annotation.
    expect(captured.err).toContain("development ⎇ agent/pr-42");
    expect(captured.err).not.toContain("(branch of");
    expect(captured.err).not.toContain("(default branch)");
  });

  test("annotates the active main branch as the default branch", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_dev",
      label: "development ⎇ main",
      branch_name: "main",
      environmentType: "development",
    });
    mockFetchApplication.mockResolvedValue({
      ...APP,
      instances: [
        { instance_id: "ins_dev", environment_type: "development", branch_name: "main" },
        ...APP.instances.slice(1),
      ],
    });
    await status({});
    expect(captured.err).toContain("development ⎇ main");
    expect(captured.err).toContain("(default branch)");
  });

  test("falls back to the development root with no annotation when no pointer is set", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);
    await status({});
    // A nameless dev root labels as `development` and gets no annotation.
    expect(captured.err).toContain("development");
    expect(captured.err).not.toContain("(trunk)");
    expect(captured.err).not.toContain("(default branch)");
  });

  test("warns on git-branch drift without prescribing a target", async () => {
    mockGetGitCurrentBranch.mockResolvedValue("main");
    await status({});
    expect(captured.err).toContain("was selected while on git branch `agent/pr-42`");
    expect(captured.err).toContain("you are now on `main`");
    expect(captured.err).toContain("run `clerk switch` to re-point");
    expect(captured.err).not.toContain("--instance");
    expect(captured.err).not.toContain("clerk switch dev");
  });

  test("emits JSON when requested with an additive branch_name", async () => {
    await status({ json: true });
    expect(JSON.parse(captured.out)).toMatchObject({
      app_id: "app_1",
      active: {
        instance_id: "ins_branch",
        label: "development ⎇ agent/pr-42",
        branch_name: "agent/pr-42",
        environment_type: "development",
        exists: true,
      },
    });
  });

  test("warns when the active instance no longer exists", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_gone",
      label: "tmp/stale",
      environmentType: "development",
    });
    await status({});
    expect(captured.err).toContain("tmp/stale · instance no longer exists");
    expect(captured.err).toContain("The active instance was deleted. Run `clerk switch`");
  });

  test("reports exists false in JSON for a dangling pointer", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_gone",
      label: "tmp/stale",
      environmentType: "development",
    });
    await status({ json: true });
    expect(JSON.parse(captured.out)).toMatchObject({
      active: { instance_id: "ins_gone", exists: false },
    });
  });

  test("degrades gracefully when the instance check fails", async () => {
    mockFetchApplication.mockRejectedValue(new Error("network down"));
    await status({ json: true });
    expect(JSON.parse(captured.out)).toMatchObject({
      active: { instance_id: "ins_branch", exists: null },
    });
  });

  test("renders without annotation when the instance check fails", async () => {
    mockFetchApplication.mockRejectedValue(new Error("network down"));
    await status({});
    expect(captured.err).toContain("agent/pr-42");
    expect(captured.err).not.toContain("no longer exists");
    expect(captured.err).not.toContain("(branch of");
  });

  test("throws NOT_LINKED when no project is linked", async () => {
    mockResolveProfile.mockResolvedValue(undefined);
    await expect(status({})).rejects.toThrow(/No Clerk project linked/);
  });

  test("ignores a stale cross-app pointer and falls back to development", async () => {
    // The cross-app guard now lives inside getActiveInstanceForApp itself
    // (see config.test.ts for coverage of the guard logic); here we simulate
    // its result for an out-of-app pointer, which is `undefined`.
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);
    await status({ json: true });
    expect(JSON.parse(captured.out)).toMatchObject({
      app_id: "app_1",
      active: { instance_id: "ins_dev", label: "development" },
      git_drift: null,
    });
  });
});
