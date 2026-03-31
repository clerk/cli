import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { configStubs } from "../../test/stubs.ts";

const mockLogin = mock();
mock.module("../auth/login.js", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

const mockLink = mock();
mock.module("../link/index.js", () => ({
  link: (...args: unknown[]) => mockLink(...args),
}));

mock.module("../env/pull.js", () => ({
  pull: async () => {},
}));

const mockIsAgent = mock();
mock.module("../../mode.js", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: () => true,
  getMode: () => "human",
  setMode: () => {},
}));

const mockLookupFramework = mock();
mock.module("../../lib/framework.js", () => ({
  lookupFramework: (...args: unknown[]) => mockLookupFramework(...args),
}));

const mockResolveProfile = mock();
mock.module("../../lib/config.js", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

const mockGatherContext = mock();
mock.module("./context.js", () => ({
  gatherContext: (...args: unknown[]) => mockGatherContext(...args),
}));

mock.module("./scaffold.js", () => ({
  scaffold: async () => ({ actions: [], postInstructions: [] }),
  enrichProjectContext: async () => {},
}));

mock.module("./preview.js", () => ({
  previewPlan: () => {},
  previewAndConfirm: async () => true,
}));

mock.module("./format.js", () => ({
  runFormatters: async () => {},
}));

mock.module("./scan.js", () => ({
  detectAuthLibraries: () => {},
  scanForIssues: async () => [],
}));

const mockGetAuthenticatedEmail = mock();
mock.module("./heuristics.js", () => ({
  installSdk: async () => {},
  writePlan: async () => [],
  checkGitDirty: async () => false,
  printOutro: () => {},
  getAuthenticatedEmail: (...args: unknown[]) => mockGetAuthenticatedEmail(...args),
}));

const { init } = await import("./index.ts");

describe("init next-steps ordering", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    mockLogin.mockReset();
    mockLink.mockReset();
    mockIsAgent.mockReset();
    mockLookupFramework.mockReset();
    mockResolveProfile.mockReset();
    mockGatherContext.mockReset();
    mockGetAuthenticatedEmail.mockReset();
    consoleSpy?.mockRestore();
  });

  test("suppresses auth next-steps when login runs during init", async () => {
    mockIsAgent.mockReturnValue(false);
    mockGatherContext.mockResolvedValue(null);
    mockGetAuthenticatedEmail.mockResolvedValue(null);
    mockResolveProfile.mockResolvedValue(undefined);
    mockLogin.mockResolvedValue({ userId: "user_1", email: "test@test.com" });
    mockLink.mockResolvedValue(undefined);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await init({ yes: true });

    expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false });
    expect(mockLink).toHaveBeenCalledWith({ skipIfLinked: true });
  });
});
