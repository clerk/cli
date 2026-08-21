import { describe, expect, spyOn, test } from "bun:test";
import type { FrameworkInfo } from "../../lib/framework.ts";
import * as telemetryMod from "../../lib/telemetry.ts";
import type { IOSProjectInspectionResult } from "../init/ios/types.ts";
import { checkEnvVars } from "./checks.ts";
import {
  getDoctorChecks,
  runChecks,
  validateDoctorOptions,
  type DoctorRunDependencies,
} from "./index.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

const IOS_FRAMEWORK: FrameworkInfo = {
  dep: "ios",
  name: "iOS (Swift)",
  sdk: "ClerkKit",
  envVar: "CLERK_PUBLISHABLE_KEY",
  envFile: ".env",
  ecosystem: "swift",
};

const IOS_INSPECTION = {} as IOSProjectInspectionResult;
const DOCTOR_CONTEXT = {} as DoctorContext;

function passingResult(name: string): CheckResult {
  return { name, status: "pass", message: `${name} passed` };
}

function runDependencies(overrides: Partial<DoctorRunDependencies> = {}): DoctorRunDependencies {
  return {
    detectFramework: async () => IOS_FRAMEWORK,
    getDoctorChecks: () => [async () => passingResult("Common")],
    runIOSDoctorChecks: async () => ({
      inspection: IOS_INSPECTION,
      results: [passingResult("iOS")],
    }),
    runIOSXcodeVerification: async () => [passingResult("Xcode")],
    ...overrides,
  };
}

describe("getDoctorChecks", () => {
  test("replaces the web environment check for iOS projects", () => {
    expect(getDoctorChecks(true)).not.toContain(checkEnvVars);
    expect(getDoctorChecks(false)).toContain(checkEnvVars);
  });
});

describe("validateDoctorOptions", () => {
  test("rejects device selection without simulator launch", () => {
    expect(() => validateDoctorOptions({ device: "SIM-UDID" })).toThrow(
      "--device can only be used with --simulator",
    );
  });

  test("rejects scheme selection when no Xcode phase was requested", () => {
    expect(() => validateDoctorOptions({ scheme: "MyApp" })).toThrow(
      "--xcode-container and --scheme require",
    );
  });

  test("prevents auto-fix from executing Xcode twice", () => {
    expect(() => validateDoctorOptions({ fix: true, build: true })).toThrow(
      "--fix cannot be combined with Xcode execution flags",
    );
  });
});

describe("doctor telemetry stages", () => {
  test("reports the ordered iOS and Xcode diagnostic boundaries", async () => {
    const stage = spyOn(telemetryMod, "setTelemetryStage");
    try {
      await runChecks(DOCTOR_CONTEXT, { build: true }, { dependencies: runDependencies() });

      expect(stage.mock.calls.map((call) => call[0])).toEqual([
        "doctor_checks",
        "doctor_ios_audit",
        "doctor_xcode",
      ]);
    } finally {
      stage.mockRestore();
    }
  });

  test("stops at the iOS audit stage when semantic inspection fails", async () => {
    const stage = spyOn(telemetryMod, "setTelemetryStage");
    try {
      const results = await runChecks(
        DOCTOR_CONTEXT,
        { target: "MyApp" },
        {
          dependencies: runDependencies({
            runIOSDoctorChecks: async () => {
              throw new Error("inspection failed");
            },
          }),
        },
      );

      expect(results.at(-1)?.status).toBe("fail");
      expect(stage.mock.calls.map((call) => call[0]).at(-1)).toBe("doctor_ios_audit");
    } finally {
      stage.mockRestore();
    }
  });

  test("stops at the Xcode stage when opt-in execution fails", async () => {
    const stage = spyOn(telemetryMod, "setTelemetryStage");
    try {
      const results = await runChecks(
        DOCTOR_CONTEXT,
        { build: true },
        {
          dependencies: runDependencies({
            runIOSXcodeVerification: async () => {
              throw new Error("build failed");
            },
          }),
        },
      );

      expect(results.at(-1)?.status).toBe("fail");
      expect(stage.mock.calls.map((call) => call[0]).at(-1)).toBe("doctor_xcode");
    } finally {
      stage.mockRestore();
    }
  });
});
