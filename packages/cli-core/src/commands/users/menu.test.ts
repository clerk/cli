import { test, expect, describe, beforeEach, mock } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockSelect = mock();
const mockIntro = mock();
const mockOutro = mock();
const mockIsAgent = mock(() => false);
const mockThrowUsageError = mock((msg: string) => {
  throw new Error(msg);
});

mock.module("../../lib/listage.ts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  filterChoices: () => [],
  Separator: class {},
}));
mock.module("../../lib/spinner.ts", () => ({
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));
mock.module("../../mode.ts", () => ({
  isAgent: () => mockIsAgent(),
  isHuman: () => !mockIsAgent(),
  setMode: () => {},
  getMode: () => "human",
}));
mock.module("../../lib/errors.ts", () => ({
  throwUsageError: (msg: string) => mockThrowUsageError(msg),
  CliError: class extends Error {},
  ERROR_CODE: {},
  EXIT_CODE: { USAGE: 2 },
}));

const { __resetUsersActionRegistryForTesting, registerUsersAction } = await import("./registry.ts");
const { usersMenu } = await import("./menu.ts");

describe("usersMenu", () => {
  useCaptureLog();

  beforeEach(() => {
    __resetUsersActionRegistryForTesting();
    mockSelect.mockReset();
    mockIntro.mockReset();
    mockOutro.mockReset();
    // Use mockClear to preserve the throwing implementation between tests.
    mockThrowUsageError.mockClear();
    mockIsAgent.mockReturnValue(false);
  });

  test("dispatches to the selected action handler with targeting options", async () => {
    const handlerCalls: unknown[] = [];
    registerUsersAction({
      key: "create",
      label: "Create user",
      description: "Create a new user",
      handler: async (t) => {
        handlerCalls.push(t);
      },
    });
    mockSelect.mockResolvedValue("create");

    await usersMenu({ app: "app_123" });

    expect(mockIntro).toHaveBeenCalledWith("clerk users");
    expect(mockSelect).toHaveBeenCalled();
    expect(handlerCalls).toEqual([{ app: "app_123" }]);
  });

  test("in agent mode, prints structured guidance and throws usage error", async () => {
    mockIsAgent.mockReturnValue(true);
    registerUsersAction({
      key: "create",
      label: "Create user",
      description: "Create a new user",
      handler: async () => {},
    });

    await expect(usersMenu({})).rejects.toThrow();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockThrowUsageError).toHaveBeenCalled();
  });
});
