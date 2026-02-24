import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
}));

const mockGetToken = mock();
mock.module("../../lib/credential-store.ts", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockLogin = mock();
mock.module("../auth/login.ts", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

const mockListApplications = mock();
const mockFetchApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
}));

const mockSetProfile = mock();
const mockResolveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  setProfile: (...args: unknown[]) => mockSetProfile(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

const mockSelect = mock();
const mockConfirm = mock();
mock.module("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { link } = await import("./index.ts");

const mockApp = {
  application_id: "app_123",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", secret_key: "sk_test", publishable_key: "pk_test" },
    { instance_id: "ins_prod", environment_type: "production", secret_key: "sk_live", publishable_key: "pk_live" },
  ],
};

describe("link", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    mockIsAgent.mockReset();
    mockGetToken.mockReset();
    mockLogin.mockReset();
    mockListApplications.mockReset();
    mockFetchApplication.mockReset();
    mockSetProfile.mockReset();
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue(undefined);
    mockSelect.mockReset();
    mockConfirm.mockReset();
    consoleSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("linking a Clerk application");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });
  });

  describe("already linked", () => {
    test("notifies and returns when user declines re-link", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: process.cwd(),
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Already linked");
      expect(output).toContain("app_existing");
      expect(mockConfirm).toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });

    test("proceeds with re-link when user confirms", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: process.cwd(),
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalled();
    });
  });

  describe("authentication", () => {
    test("calls login when no token exists", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ userId: "user_1", email: "test@test.com" });
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockLogin).toHaveBeenCalled();
    });

    test("skips login when token exists", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("oauth_token_123");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockLogin).not.toHaveBeenCalled();
    });
  });

  describe("app selection", () => {
    test("uses --app flag to skip picker", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockListApplications).not.toHaveBeenCalled();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows interactive picker when no --app flag", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        { application_id: "app_a", instances: [{ instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" }] },
        { application_id: "app_b", instances: [{ instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" }] },
      ]);
      mockSelect.mockResolvedValue("app_a");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockListApplications).toHaveBeenCalled();
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("exits when no apps found", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([]);
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

      await expect(link()).rejects.toThrow("exit");

      expect(errorSpy.mock.calls[0][0]).toContain("No applications found");
    });
  });

  describe("profile storage", () => {
    test("stores profile with correct data", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockSetProfile).toHaveBeenCalledWith(process.cwd(), {
        workspaceId: "",
        appId: "app_123",
        instances: {
          development: "ins_dev",
          production: "ins_prod",
        },
      });
    });

    test("omits production when not available", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue({
        application_id: "app_123",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", secret_key: "sk_test", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      const storedProfile = mockSetProfile.mock.calls[0][1];
      expect(storedProfile.instances.production).toBeUndefined();
    });

    test("exits when no development instance", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue({
        application_id: "app_123",
        instances: [
          { instance_id: "ins_prod", environment_type: "production", secret_key: "sk_live", publishable_key: "pk_live" },
        ],
      });
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

      await expect(link({ app: "app_123" })).rejects.toThrow("exit");

      expect(errorSpy.mock.calls[0][0]).toContain("no development instance");
    });

    test("logs confirmation message", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("Linked to");
    });
  });
});
