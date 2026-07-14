import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveProfile = mock();
const mockResolveActiveKey = mock();
const mockGetActiveInstanceForApp = mock();
const mockSetActiveInstance = mock();
const mockFetchApplication = mock();
const mockCreateBranch = mock();
const mockPull = mock();
const mockConfirm = mock();
const mockGetGitCurrentBranch = mock();
const mockIsAgent = mock();
const mockIntro = mock();
const mockOutro = mock();
const mockPausedOutro = mock();

mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...a: unknown[]) => mockResolveProfile(...a),
  resolveActiveKey: (...a: unknown[]) => mockResolveActiveKey(...a),
  getActiveInstanceForApp: (...a: unknown[]) => mockGetActiveInstanceForApp(...a),
  setActiveInstance: (...a: unknown[]) => mockSetActiveInstance(...a),
  // branch/shared.ts (resolveSwitchTarget/pickInstance) imports these pure
  // helpers from config.ts too; mirror the real implementations so mocking
  // the whole module doesn't break shared.ts's imports.
  INSTANCE_ALIASES: {
    dev: "development",
    development: "development",
    prod: "production",
    production: "production",
  },
  isPrimaryInstance: (i: { parent_instance_id?: string }) => !i.parent_instance_id,
  instanceLabel: (i: { environment_type: string; branch_name?: string }) =>
    i.branch_name ? `${i.environment_type} ⎇ ${i.branch_name}` : i.environment_type,
}));
mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...a: unknown[]) => mockFetchApplication(...a),
  createBranch: (...a: unknown[]) => mockCreateBranch(...a),
  PlapiError: class PlapiError extends Error {},
}));
mock.module("../env/pull.ts", () => ({ pull: (...a: unknown[]) => mockPull(...a) }));
mock.module("../../lib/prompts.ts", () => ({ confirm: (...a: unknown[]) => mockConfirm(...a) }));
mock.module("../../lib/git.ts", () => ({
  getGitCurrentBranch: (...a: unknown[]) => mockGetGitCurrentBranch(...a),
}));
mock.module("../../mode.ts", () => ({
  isAgent: (...a: unknown[]) => mockIsAgent(...a),
  isHuman: (...a: unknown[]) => !mockIsAgent(...a),
  setMode: () => {},
  getMode: () => "human",
}));
mock.module("../../lib/spinner.ts", () => ({
  intro: (...a: unknown[]) => mockIntro(...a),
  outro: (...a: unknown[]) => mockOutro(...a),
  pausedOutro: (...a: unknown[]) => mockPausedOutro(...a),
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  withSpinner: async (_m: string, fn: () => Promise<unknown>) => fn(),
}));

const { branchSwitch } = await import("./switch.ts");

const APP = {
  application_id: "app_1",
  name: "my-app",
  // Branching is enabled, so the passive gate (ADR-0015) lets `switch --create`
  // fork.
  branches_available: true,
  branches_enabled: true,
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

describe("branch switch", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveProfile.mockResolvedValue({
      path: "/repo",
      profile: {
        appId: "app_1",
        appName: "my-app",
        instances: { development: "ins_dev", production: "ins_prod" },
      },
      resolvedVia: "directory",
    });
    mockResolveActiveKey.mockResolvedValue("/repo");
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);
    mockSetActiveInstance.mockResolvedValue(undefined);
    mockFetchApplication.mockResolvedValue(APP);
    mockCreateBranch.mockResolvedValue({
      id: "ins_new",
      branch_name: "agent/pr-99",
      publishable_key: "pk_new",
      secret_key: "sk_new",
    });
    mockPull.mockResolvedValue(undefined);
    mockConfirm.mockResolvedValue(true);
    mockGetGitCurrentBranch.mockResolvedValue("agent/pr-42");
  });

  afterEach(() => {
    for (const m of [
      mockResolveProfile,
      mockResolveActiveKey,
      mockGetActiveInstanceForApp,
      mockSetActiveInstance,
      mockFetchApplication,
      mockCreateBranch,
      mockPull,
      mockConfirm,
      mockGetGitCurrentBranch,
      mockIsAgent,
      mockIntro,
      mockOutro,
      mockPausedOutro,
    ])
      m.mockReset();
  });

  test("switching to a dev branch persists the pointer and auto-pulls embedded", async () => {
    await branchSwitch("agent/pr-42", {});
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        appId: "app_1",
        instanceId: "ins_branch",
        label: "development ⎇ agent/pr-42",
        environmentType: "development",
      }),
    );
    expect(mockPull).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: "ins_branch",
        label: "development ⎇ agent/pr-42",
        embed: true,
      }),
    );
    expect(mockIntro).toHaveBeenCalledWith("Switching · my-app");
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("agent/pr-42 is now active"));
  });

  test("pulls trunks by instance id with the friendly label", async () => {
    await branchSwitch("dev", {});
    expect(mockPull).toHaveBeenCalledWith(
      expect.objectContaining({ instance: "ins_dev", label: "development", embed: true }),
    );
  });

  test("outro names the instance you left", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_dev",
      label: "development",
      environmentType: "development",
    });
    await branchSwitch("agent/pr-42", {});
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("(was development)"));
  });

  test("switching to production requires confirmation and does not auto-pull", async () => {
    await branchSwitch("prod", {});
    expect(mockConfirm).toHaveBeenCalledWith({
      message: "Target PRODUCTION? Commands will act on live data until you switch away.",
      default: false,
    });
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_prod", environmentType: "production" }),
    );
    expect(mockPull).not.toHaveBeenCalled();
    expect(captured.err).toContain(".env.local untouched.");
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("production is now active"));
  });

  test("--yes skips the production confirmation in human mode", async () => {
    await branchSwitch("prod", { yes: true });
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_prod" }),
    );
  });

  test("declining the production confirmation pauses the frame", async () => {
    mockConfirm.mockResolvedValue(false);
    await expect(branchSwitch("prod", {})).rejects.toThrow();
    expect(mockPausedOutro).toHaveBeenCalled();
    expect(mockOutro).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("agent switching to production without --yes errors with confirmation_required", async () => {
    mockIsAgent.mockReturnValue(true);
    await expect(branchSwitch("prod", {})).rejects.toMatchObject({
      message: expect.stringContaining("--yes"),
      code: "confirmation_required",
    });
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("--no-pull skips env sync for a dev branch", async () => {
    await branchSwitch("agent/pr-42", { pull: false });
    expect(mockPull).not.toHaveBeenCalled();
  });

  test("-c forks the development root, switches, and pulls", async () => {
    await branchSwitch(undefined, { create: "agent/pr-99" });
    expect(mockCreateBranch).toHaveBeenCalledWith("app_1", {
      cloneInstanceId: "ins_dev",
      branchName: "agent/pr-99",
    });
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_new", label: "development ⎇ agent/pr-99" }),
    );
    expect(mockPull).toHaveBeenCalled();
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("(branch of development)"));
  });

  test("-c refuses with the enable hint when branching is not enabled", async () => {
    mockFetchApplication.mockResolvedValue({ ...APP, branches_enabled: false });
    await expect(branchSwitch(undefined, { create: "agent/pr-99" })).rejects.toThrow(
      /aren't enabled.*clerk enable branches/s,
    );
    expect(mockCreateBranch).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("-c rejects a malformed branch name before the fork round-trip", async () => {
    await expect(branchSwitch(undefined, { create: "bad name" })).rejects.toThrow(
      /letters, numbers, and the characters/,
    );
    expect(mockCreateBranch).not.toHaveBeenCalled();
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("switching to an existing instance is not gated by enablement", async () => {
    // Only forking is gated; navigating to an existing branch always works.
    mockFetchApplication.mockResolvedValue({ ...APP, branches_enabled: false });
    await branchSwitch("agent/pr-42", { pull: false });
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_branch" }),
    );
  });

  test("--detach outro notes the pointer was not saved", async () => {
    await branchSwitch("agent/pr-42", { detach: true, pull: false });
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("(detached, not saved)"));
  });

  test("- toggles to the previous instance", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_branch",
      label: "development ⎇ agent/pr-42",
      environmentType: "development",
      previousInstanceId: "ins_dev",
      previousLabel: "development",
    });
    await branchSwitch("-", {});
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_dev", label: "development" }),
    );
  });

  test("--detach does not persist the pointer", async () => {
    await branchSwitch("ins_prod", { detach: true, yes: true });
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("prints JSON when requested", async () => {
    await branchSwitch("agent/pr-42", { json: true, pull: false });
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "switched",
      instance_id: "ins_branch",
      branch_name: "agent/pr-42",
    });
  });

  test("no-arg in agent mode prints the current pointer in the switched shape", async () => {
    mockIsAgent.mockReturnValue(true);
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_branch",
      label: "development ⎇ agent/pr-42",
      environmentType: "development",
    });
    await branchSwitch(undefined, {});
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "current",
      instance_id: "ins_branch",
      branch_name: "agent/pr-42",
      environment_type: "development",
      persisted: true,
      exists: true,
    });
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  test("no-arg in agent mode flags a dangling pointer with exists false", async () => {
    mockIsAgent.mockReturnValue(true);
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_gone",
      label: "tmp/stale",
      environmentType: "development",
    });
    await branchSwitch(undefined, {});
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "current",
      instance_id: "ins_gone",
      branch_name: null,
      environment_type: "development",
      persisted: true,
      exists: false,
    });
  });

  test("-c uses the refetched instance when the branch appears in the response", async () => {
    const created = {
      instance_id: "ins_new",
      environment_type: "development",
      publishable_key: "pk_new",
      branch_name: "agent/pr-99",
      parent_instance_id: "ins_dev",
    };
    // First fetch resolves the fork parent; the refetch already includes the new
    // instance, so branchSwitch uses the fetched record (not the synthesized one).
    mockFetchApplication.mockReset();
    mockFetchApplication
      .mockResolvedValueOnce(APP)
      .mockResolvedValueOnce({ ...APP, instances: [...APP.instances, created] });
    await branchSwitch(undefined, { create: "agent/pr-99" });
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({
        instanceId: "ins_new",
        label: "development ⎇ agent/pr-99",
        environmentType: "development",
      }),
    );
    expect(mockPull).toHaveBeenCalled();
  });

  test("-c falls back to a synthesized instance when the refetch misses it", async () => {
    // First fetch resolves the fork parent; the refetch does not yet contain the
    // newly created instance, so branchSwitch synthesizes it from createBranch's
    // response and still persists ins_new.
    mockFetchApplication.mockReset();
    mockFetchApplication
      .mockResolvedValueOnce(APP)
      .mockResolvedValueOnce({ ...APP, instances: [...APP.instances] });
    await branchSwitch(undefined, { create: "agent/pr-99" });
    expect(mockSetActiveInstance).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ instanceId: "ins_new", label: "development ⎇ agent/pr-99" }),
    );
  });

  test("- rejects when the previous instance no longer exists", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_1",
      instanceId: "ins_branch",
      label: "development ⎇ agent/pr-42",
      environmentType: "development",
      previousInstanceId: "ins_gone",
      previousLabel: "old",
    });
    await expect(branchSwitch("-", {})).rejects.toThrow("Previous instance no longer exists.");
    expect(mockSetActiveInstance).not.toHaveBeenCalled();
  });

  describe("cross-app pointer guard", () => {
    // A stale pointer left over from a worktree that was previously linked to a
    // different app must never leak into this app's "current" instance. The
    // handler resolves this via getActiveInstanceForApp(cwd, appId), which
    // already filters cross-app pointers out, so the mock returning undefined
    // here is exactly what the real guarded helper would produce.
    beforeEach(() => {
      mockGetActiveInstanceForApp.mockResolvedValue(undefined);
    });

    test("no-arg in agent mode reports no current instance instead of the stale one", async () => {
      mockIsAgent.mockReturnValue(true);
      await branchSwitch(undefined, {});
      expect(JSON.parse(captured.out)).toMatchObject({
        status: "current",
        instance_id: null,
        branch_name: null,
        environment_type: null,
        persisted: false,
        exists: null,
      });
      expect(mockSetActiveInstance).not.toHaveBeenCalled();
    });

    test("-c forks the development root even when the pointer is stale", async () => {
      await branchSwitch(undefined, { create: "agent/pr-99" });
      expect(mockCreateBranch).toHaveBeenCalledWith("app_1", {
        cloneInstanceId: "ins_dev",
        branchName: "agent/pr-99",
      });
    });
  });
});
