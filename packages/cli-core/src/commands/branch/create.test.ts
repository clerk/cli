import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockCreateBranch = mock();
const mockFetchApplication = mock();
const mockIsAgent = mock();

mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  isPrimaryInstance: (i: { parent_instance_id?: string }) => !i.parent_instance_id,
  // create.ts imports assertBranchingEnabled from shared.ts, which pulls these
  // pure helpers from config.ts; mirror them so the whole-module mock is complete.
  INSTANCE_ALIASES: {
    dev: "development",
    development: "development",
    prod: "production",
    production: "production",
  },
  instanceLabel: (i: { environment_type: string; branch_name?: string }) =>
    i.branch_name ? `${i.environment_type} ⎇ ${i.branch_name}` : i.environment_type,
}));

mock.module("../../lib/plapi.ts", () => ({
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  PlapiError: class PlapiError extends Error {},
}));

mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

mock.module("../../lib/spinner.ts", () => ({
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { branchCreate } = await import("./create.ts");

// A branching-enabled app: the dev root is named `main` and the app-level gate is
// on. Fixtures carry branches_available/branches_enabled so the passive gate
// (ADR-0015) lets the fork through.
const enabledApp = {
  application_id: "app_test123",
  name: "Test App",
  branches_available: true,
  branches_enabled: true,
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      branch_name: "main",
      publishable_key: "pk_test_aaa",
    },
  ],
};

describe("branch create", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_test123",
      appLabel: "Test App",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockFetchApplication.mockResolvedValue(enabledApp);
    mockCreateBranch.mockResolvedValue({
      object: "instance",
      id: "ins_branch",
      environment_type: "development",
      branch_name: "agent/pr-42",
      secret_key: "sk_test_branch",
      publishable_key: "pk_test_branch",
    });
  });

  afterEach(() => {
    mockResolveAppContext.mockReset();
    mockFetchApplication.mockReset();
    mockCreateBranch.mockReset();
    mockIsAgent.mockReset();
  });

  test("forks the named main root with no parent-selection flag", async () => {
    await branchCreate({ name: "agent/pr-42", app: "app_test123" });

    expect(mockResolveAppContext).toHaveBeenCalledWith({
      app: "app_test123",
      instance: "development",
    });
    expect(mockCreateBranch).toHaveBeenCalledWith("app_test123", {
      cloneInstanceId: "ins_dev",
      branchName: "agent/pr-42",
    });
    // Fork message uses the bare parent branch name.
    expect(captured.err).toContain("Forked `main`");
    expect(captured.err).toContain("agent/pr-42");
  });

  test("prints JSON output when requested", async () => {
    await branchCreate({ name: "agent/pr-42", json: true });

    expect(JSON.parse(captured.out)).toEqual({
      status: "created",
      branch_name: "agent/pr-42",
      instance_id: "ins_branch",
      parent_instance_id: "ins_dev",
    });
  });

  test("refuses with the enable hint when branching is available but not enabled", async () => {
    mockFetchApplication.mockResolvedValue({
      ...enabledApp,
      branches_enabled: false,
      instances: [
        { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test_aaa" },
      ],
    });

    await expect(branchCreate({ name: "agent/pr-42" })).rejects.toThrow(
      /aren't enabled.*clerk enable branches/s,
    );
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });

  test("refuses with the not-available message when branching is not available", async () => {
    mockFetchApplication.mockResolvedValue({
      ...enabledApp,
      branches_available: false,
      branches_enabled: false,
      instances: [
        { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test_aaa" },
      ],
    });

    await expect(branchCreate({ name: "agent/pr-42" })).rejects.toThrow(/aren't available/);
    expect(mockCreateBranch).not.toHaveBeenCalled();
  });
});
