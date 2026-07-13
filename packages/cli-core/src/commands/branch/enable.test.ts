import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockUpdateBranchSettings = mock();

mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
}));

mock.module("../../lib/plapi.ts", () => ({
  updateBranchSettings: (...args: unknown[]) => mockUpdateBranchSettings(...args),
  PlapiError: class PlapiError extends Error {},
}));

mock.module("../../mode.ts", () => ({
  isAgent: () => false,
  isHuman: () => true,
  setMode: () => {},
  getMode: () => "human",
}));

mock.module("../../lib/spinner.ts", () => ({
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  withGutter: async (_title: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ setNextSteps: () => {} }),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { branchesEnable, branchesDisable } = await import("./enable.ts");

describe("branches enable/disable", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    mockResolveAppContext.mockResolvedValue({
      appId: "app_1",
      appLabel: "My App",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockUpdateBranchSettings.mockResolvedValue({
      object: "branch_settings",
      branches_available: true,
      branches_enabled: true,
    });
  });

  afterEach(() => {
    mockResolveAppContext.mockReset();
    mockUpdateBranchSettings.mockReset();
  });

  test("enable calls the Platform route with enabled=true and points at branch create", async () => {
    await branchesEnable({ app: "app_1" });
    expect(mockUpdateBranchSettings).toHaveBeenCalledWith("app_1", true);
    // The next-step hint is a plain log line (the success text is spinner chrome).
    expect(captured.err).toContain("clerk branch create");
  });

  test("disable calls the Platform route with enabled=false", async () => {
    mockUpdateBranchSettings.mockResolvedValue({
      object: "branch_settings",
      branches_available: true,
      branches_enabled: false,
    });
    await branchesDisable({ app: "app_1" });
    expect(mockUpdateBranchSettings).toHaveBeenCalledWith("app_1", false);
  });

  test("enable surfaces a server refusal (e.g. not available)", async () => {
    mockUpdateBranchSettings.mockRejectedValue(
      new Error("Development branches aren't available for this instance."),
    );
    await expect(branchesEnable({ app: "app_1" })).rejects.toThrow(/aren't available/);
  });

  test("disable surfaces a server refusal while forks exist", async () => {
    mockUpdateBranchSettings.mockRejectedValue(new Error("Delete your branches before disabling."));
    await expect(branchesDisable({ app: "app_1" })).rejects.toThrow(/Delete your branches/);
  });
});
