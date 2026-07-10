import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockCreateBranch = mock();
const mockIsAgent = mock();

mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
}));

mock.module("../../lib/plapi.ts", () => ({
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
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
    mockCreateBranch.mockReset();
    mockIsAgent.mockReset();
  });

  test("forks the development root with no parent-selection flag", async () => {
    await branchCreate({ name: "agent/pr-42", app: "app_test123" });

    expect(mockResolveAppContext).toHaveBeenCalledWith({
      app: "app_test123",
      instance: "development",
    });
    expect(mockCreateBranch).toHaveBeenCalledWith("app_test123", {
      cloneInstanceId: "ins_dev",
      branchName: "agent/pr-42",
    });
    expect(captured.err).toContain("Forked `development`");
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
});
