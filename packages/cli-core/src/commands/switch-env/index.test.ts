import { test, expect, describe } from "bun:test";
import { switchEnv } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const MOCK_ENVS = ["production", "staging"];

function envDeps(
  opts: {
    currentEnv?: string;
    token?: string | null;
  } = {},
) {
  let current = opts.currentEnv ?? "production";
  return testRoot({
    environment: {
      getAvailableEnvs: () => MOCK_ENVS,
      isValidEnv: (name: string) => MOCK_ENVS.includes(name),
      getCurrentEnvName: () => current,
      setCurrentEnv: (name: string) => {
        current = name;
      },
    },
    configStore: {
      setEnvironment: async () => {},
    },
    credentialStore: {
      getToken: async () => opts.token ?? null,
    },
  });
}

describe("switch-env", () => {
  test("prints current environment when no argument given", async () => {
    const deps = envDeps();
    await switchEnv(deps, undefined);

    expect(deps.log.info).toHaveBeenCalledWith("Current environment: production");
    expect(deps.log.info).toHaveBeenCalledWith("Available environments: production, staging");
  });

  test("switches to a valid environment", async () => {
    const deps = envDeps({ token: "some-token" });
    await switchEnv(deps, "staging");

    expect(deps.environment.setCurrentEnv).toHaveBeenCalledWith("staging");
    expect(deps.configStore.setEnvironment).toHaveBeenCalledWith("staging");
    expect(deps.log.info).toHaveBeenCalledWith("Switched from production to staging.");
  });

  test("reports already on environment when switching to current", async () => {
    const deps = envDeps({ token: "some-token" });
    await switchEnv(deps, "production");

    expect(deps.log.info).toHaveBeenCalledWith("Already on production environment.");
  });

  test("throws on invalid environment", async () => {
    const deps = envDeps();
    await expect(switchEnv(deps, "nonexistent")).rejects.toThrow(
      'Unknown environment "nonexistent". Available environments: production, staging',
    );
  });

  test("warns about missing credentials after switching", async () => {
    const deps = envDeps({ token: null });
    await switchEnv(deps, "staging");

    expect(deps.log.info).toHaveBeenCalledWith(
      "No credentials found for staging. Run `clerk auth login` to authenticate.",
    );
  });

  test("does not warn about credentials when token exists", async () => {
    const deps = envDeps({ token: "valid-token" });
    await switchEnv(deps, "staging");

    expect(deps.log.info).not.toHaveBeenCalledWith(expect.stringContaining("No credentials found"));
  });
});
