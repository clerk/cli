import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { setMode } from "../../mode.ts";
import * as frameworkMod from "../../lib/framework.ts";
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
let androidOptions: unknown;
mock.module("./android.ts", () => ({
  runAndroidDoctorChecks: async (_ctx: unknown, options: unknown): Promise<CheckResult[]> => {
    androidOptions = options;
    return [{ name: "SDK dependency", status: "pass", message: "ok" }];
  },
}));
let detected: string | undefined;

const { doctor } = await import("./index.ts");

describe("doctor for Android projects", () => {
  const captured = useCaptureLog();
  let detect: ReturnType<typeof spyOn>;
  beforeEach(() => {
    setMode("human");
    detected = undefined;
    androidOptions = undefined;
    detect = spyOn(frameworkMod, "detectFramework").mockImplementation(
      async () => (detected ? { dep: detected } : null) as never,
    );
  });
  afterEach(() => detect.mockRestore());

  async function names(options: Parameters<typeof doctor>[0]): Promise<string[]> {
    await doctor({ ...options, json: true });
    return (JSON.parse(captured.out) as CheckResult[]).map((result) => result.name);
  }

  test("an Android selection adds the Android checks and skips the env file check", async () => {
    const result = await names({ androidModule: "app", androidPackage: "com.example.app" });
    expect(result).toContain("SDK dependency");
    expect(result).not.toContain(CHECK_NAME.envVars);
    expect(result).not.toContain("SDK project linkage");
    expect(androidOptions).toMatchObject({
      androidModule: "app",
      androidPackage: "com.example.app",
    });
  });

  test("a detected Android project gets the same checks", async () => {
    detected = "android";
    const result = await names({});
    expect(result).toContain("SDK dependency");
    expect(result).not.toContain(CHECK_NAME.envVars);
  });

  test("other projects keep the usual checks", async () => {
    const result = await names({});
    expect(result).toContain(CHECK_NAME.envVars);
    expect(result).not.toContain("SDK dependency");
  });
});
