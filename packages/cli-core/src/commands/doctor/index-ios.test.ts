import { test, expect, describe, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { CHECK_NAME, type CheckKey, type CheckResult } from "./types.ts";

const pass = (key: CheckKey) => async (): Promise<CheckResult> => ({
  name: CHECK_NAME[key],
  status: "pass",
  message: "ok",
});

// Replaced wholesale, so every export of checks.ts has to be here.
mock.module("./checks.ts", () => ({
  checkCliVersion: pass("cliVersion"),
  checkHostExecution: pass("hostExecution"),
  checkLoggedIn: pass("loggedIn"),
  checkTokenValid: pass("tokenValid"),
  checkProjectLinked: pass("projectLinked"),
  checkLinkedAppExists: pass("linkedAppExists"),
  checkInstances: pass("instances"),
  checkEnvVars: pass("envVars"),
  checkConfigFile: pass("configFile"),
  checkShellCompletion: pass("shellCompletion"),
}));
mock.module("./check-mcp.ts", () => ({ checkMcp: pass("mcp") }));
mock.module("./ios.ts", () => ({
  runIOSDoctorChecks: async (): Promise<CheckResult[]> => [
    { name: "SDK project linkage", status: "pass", message: "ok" },
  ],
}));

let xcode = true;
mock.module("../init/ios/coordinator.ts", () => ({ canSetUpXcode: () => xcode }));

const { doctor } = await import("./index.ts");

describe("doctor for native Apple projects", () => {
  const captured = useCaptureLog();
  beforeEach(() => setMode("human"));

  async function names(options: Parameters<typeof doctor>[0]): Promise<string[]> {
    await doctor({ ...options, json: true });
    return (JSON.parse(captured.out) as CheckResult[]).map((result) => result.name);
  }

  test("an Xcode selection adds the Apple checks and skips the env file check", async () => {
    const result = await names({ xcodeTarget: "MyApp" });
    expect(result).toContain("SDK project linkage");
    expect(result).not.toContain(CHECK_NAME.envVars);
  });

  test("without Xcode, an iOS project keeps the env file check init falls back to", async () => {
    xcode = false;
    try {
      const result = await names({ xcodeTarget: "MyApp" });
      expect(result).toContain(CHECK_NAME.envVars);
      expect(result).toContain("SDK project linkage");
    } finally {
      xcode = true;
    }
  });

  test("other projects keep the usual checks", async () => {
    const result = await names({});
    expect(result).toContain(CHECK_NAME.envVars);
    expect(result).not.toContain("SDK project linkage");
  });
});
