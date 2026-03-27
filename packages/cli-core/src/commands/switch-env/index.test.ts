import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { configStubs, credentialStoreStubs } from "../../test/stubs.ts";

const mockSetEnvironment = mock();
const mockGetToken = mock();
let mockCurrentEnv = "production";

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setEnvironment: (...args: unknown[]) => mockSetEnvironment(...args),
}));

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const MOCK_ENVS = ["production", "staging"];

mock.module("../../lib/environment.ts", () => ({
  getCurrentEnvName: () => mockCurrentEnv,
  getAvailableEnvs: () => MOCK_ENVS,
  isValidEnv: (name: string) => MOCK_ENVS.includes(name),
  setCurrentEnv: (name: string) => {
    mockCurrentEnv = name;
  },
}));

const { switchEnv } = await import("./index.ts");

describe("switch-env", () => {
  let logSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    mockSetEnvironment.mockReset();
    mockGetToken.mockReset();
    mockCurrentEnv = "production";
    logSpy?.mockRestore();
  });

  test("prints current environment when no argument given", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    await switchEnv(undefined);

    expect(logSpy).toHaveBeenCalledWith("Current environment: production");
    expect(logSpy).toHaveBeenCalledWith("Available environments: production, staging");
  });

  test("switches to a valid environment", async () => {
    mockSetEnvironment.mockResolvedValue(undefined);
    mockGetToken.mockResolvedValue("some-token");

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    await switchEnv("staging");

    expect(mockCurrentEnv).toBe("staging");
    expect(mockSetEnvironment).toHaveBeenCalledWith("staging");
    expect(logSpy).toHaveBeenCalledWith("Switched from production to staging.");
  });

  test("reports already on environment when switching to current", async () => {
    mockSetEnvironment.mockResolvedValue(undefined);
    mockGetToken.mockResolvedValue("some-token");

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    await switchEnv("production");

    expect(logSpy).toHaveBeenCalledWith("Already on production environment.");
  });

  test("throws on invalid environment", async () => {
    await expect(switchEnv("nonexistent")).rejects.toThrow(
      'Unknown environment "nonexistent". Available environments: production, staging',
    );
  });

  test("warns about missing credentials after switching", async () => {
    mockSetEnvironment.mockResolvedValue(undefined);
    mockGetToken.mockResolvedValue(null);

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    await switchEnv("staging");

    expect(logSpy).toHaveBeenCalledWith(
      "No credentials found for staging. Run `clerk auth login` to authenticate.",
    );
  });

  test("does not warn about credentials when token exists", async () => {
    mockSetEnvironment.mockResolvedValue(undefined);
    mockGetToken.mockResolvedValue("valid-token");

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    await switchEnv("staging");

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("No credentials found"));
  });
});
