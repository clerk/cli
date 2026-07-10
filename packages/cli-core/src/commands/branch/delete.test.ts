import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockFetchApplication = mock();
const mockDeleteInstance = mock();
const mockConfirm = mock();
const mockIsAgent = mock();
const mockGetActiveInstanceForApp = mock();
const mockIntro = mock();
const mockOutro = mock();
const mockPausedOutro = mock();

mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  getActiveInstanceForApp: (...args: unknown[]) => mockGetActiveInstanceForApp(...args),
}));

mock.module("../../lib/plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  deleteInstance: (...args: unknown[]) => mockDeleteInstance(...args),
  PlapiError: class PlapiError extends Error {},
}));

mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

mock.module("../../lib/spinner.ts", () => ({
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  pausedOutro: (...args: unknown[]) => mockPausedOutro(...args),
  withSpinner: async (msg: string, fn: () => Promise<unknown>, doneMessage?: string) => {
    console.error(msg);
    const result = await fn();
    if (doneMessage) console.error(doneMessage);
    return result;
  },
}));

const { branchDelete } = await import("./delete.ts");

describe("branch delete", () => {
  const captured = useCaptureLog();
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    mockIsAgent.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_test123",
      appLabel: "Test App",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockFetchApplication.mockResolvedValue({
      application_id: "app_test123",
      instances: [
        {
          instance_id: "ins_branch",
          environment_type: "development",
          publishable_key: "pk_test_branch",
          branch_name: "agent/pr-42",
        },
      ],
    });
    mockConfirm.mockResolvedValue(true);
    mockDeleteInstance.mockResolvedValue({});
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    mockResolveAppContext.mockReset();
    mockFetchApplication.mockReset();
    mockDeleteInstance.mockReset();
    mockConfirm.mockReset();
    mockIsAgent.mockReset();
    mockGetActiveInstanceForApp.mockReset();
    mockIntro.mockReset();
    mockOutro.mockReset();
    mockPausedOutro.mockReset();
  });

  test("requires --yes in agent mode with a confirmation_required code", async () => {
    mockIsAgent.mockReturnValue(true);

    await expect(branchDelete({ name: "agent/pr-42" })).rejects.toMatchObject({
      message: "Pass --yes to delete a branch in agent mode.",
      code: "confirmation_required",
    });
    expect(mockDeleteInstance).not.toHaveBeenCalled();
  });

  test("deletes the named branch instance inside a frame", async () => {
    await branchDelete({ name: "agent/pr-42", app: "app_test123", yes: true });

    expect(mockResolveAppContext).toHaveBeenCalledWith({ app: "app_test123", cwd: undefined });
    expect(mockFetchApplication).toHaveBeenCalledWith("app_test123");
    expect(mockDeleteInstance).toHaveBeenCalledWith("app_test123", "ins_branch");
    expect(mockIntro).toHaveBeenCalledWith("Deleting branch · agent/pr-42");
    expect(errorSpy).toHaveBeenCalledWith("Deleted agent/pr-42 (ins_branch)");
    expect(mockOutro).toHaveBeenCalled();
  });

  test("confirm names the blast radius and declining pauses the frame", async () => {
    mockConfirm.mockResolvedValue(false);

    await expect(branchDelete({ name: "agent/pr-42" })).rejects.toThrow();
    expect(mockConfirm).toHaveBeenCalledWith({
      message:
        "Permanently delete `agent/pr-42` and its instance? Users and settings on it are lost.",
      default: false,
    });
    expect(mockDeleteInstance).not.toHaveBeenCalled();
    expect(mockPausedOutro).toHaveBeenCalled();
    expect(mockOutro).not.toHaveBeenCalled();
  });

  test("prints JSON output when requested", async () => {
    await branchDelete({ name: "agent/pr-42", yes: true, json: true });

    expect(JSON.parse(captured.out)).toEqual({
      status: "deleted",
      branch_name: "agent/pr-42",
      instance_id: "ins_branch",
    });
  });

  test("rejects unknown branch names", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_test123",
      instances: [],
    });

    await expect(branchDelete({ name: "missing", yes: true })).rejects.toThrow(
      'No branch named "missing".',
    );
    expect(mockDeleteInstance).not.toHaveBeenCalled();
  });

  test("refuses to delete the active branch with an active_instance code", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_test123",
      instanceId: "ins_branch",
      label: "agent/pr-42",
      environmentType: "development",
    });

    await expect(branchDelete({ name: "agent/pr-42", yes: true })).rejects.toMatchObject({
      message: expect.stringContaining("active instance"),
      code: "active_instance",
    });
    expect(mockDeleteInstance).not.toHaveBeenCalled();
  });

  test("deletes a branch that is not the active instance", async () => {
    mockGetActiveInstanceForApp.mockResolvedValue({
      appId: "app_test123",
      instanceId: "ins_OTHER",
      label: "development",
      environmentType: "development",
    });

    await branchDelete({ name: "agent/pr-42", yes: true });
    expect(mockDeleteInstance).toHaveBeenCalledWith("app_test123", "ins_branch");
  });

  test("ignores a stale cross-app active pointer when deleting", async () => {
    // The cross-app guard now lives inside getActiveInstanceForApp itself
    // (see config.test.ts for coverage of the guard logic); here we simulate
    // its result for an out-of-app pointer, which is `undefined`.
    mockGetActiveInstanceForApp.mockResolvedValue(undefined);

    await branchDelete({ name: "agent/pr-42", yes: true });
    expect(mockDeleteInstance).toHaveBeenCalledWith("app_test123", "ins_branch");
  });
});
