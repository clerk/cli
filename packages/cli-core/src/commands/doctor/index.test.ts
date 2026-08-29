import { describe, expect, spyOn, test } from "bun:test";
import type { FrameworkInfo } from "../../lib/framework.ts";
import * as telemetryMod from "../../lib/telemetry.ts";
import type { IOSProjectInspectionResult } from "../init/ios/types.ts";
import { checkEnvVars } from "./checks.ts";
import { getDoctorChecks, runChecks, type DoctorRunDependencies } from "./index.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

const IOS_FRAMEWORK: FrameworkInfo = {
  dep: "ios",
  name: "iOS (Swift)",
  sdk: "ClerkKit",
  envVar: "CLERK_PUBLISHABLE_KEY",
  envFile: ".env",
  ecosystem: "swift",
};

const IOS_INSPECTION = {
  platform: "ios",
  appTargets: [{ platform: "ios" }],
  selection: { state: "selected", platform: "ios" },
} as IOSProjectInspectionResult;
const MACOS_INSPECTION = {
  platform: "macos",
  appTargets: [{ platform: "macos" }],
  selection: { state: "selected", platform: "macos" },
} as IOSProjectInspectionResult;
const UNSUPPORTED_XCODE_INSPECTION = {
  schemaVersion: 1,
  platform: "apple-native",
  root: "/fixture",
  workspaces: [],
  projects: [],
  appTargets: [],
  selection: { state: "none" },
  localPublishableKey: { state: "missing" },
  generatedProject: null,
  diagnostics: [],
} as IOSProjectInspectionResult;
const MISSING_TARGET_INSPECTION = {
  ...UNSUPPORTED_XCODE_INSPECTION,
  platform: "ios",
  selection: {
    state: "not-found",
    requested: "MissingApp",
    candidates: ["MyApp (APP_TARGET)"],
  },
} as IOSProjectInspectionResult;
const DOCTOR_CONTEXT = {} as DoctorContext;

function passingResult(name: string): CheckResult {
  return { name, status: "pass", message: `${name} passed` };
}

function runDependencies(overrides: Partial<DoctorRunDependencies> = {}): DoctorRunDependencies {
  return {
    detectFramework: async () => IOS_FRAMEWORK,
    inspectIOSProject: async () => IOS_INSPECTION,
    getDoctorChecks: () => [async () => passingResult("Common")],
    runIOSDoctorChecks: async () => ({
      inspection: IOS_INSPECTION,
      results: [passingResult("iOS")],
    }),
    ...overrides,
  };
}

describe("getDoctorChecks", () => {
  test("replaces the web environment check for iOS projects", () => {
    expect(getDoctorChecks(true)).not.toContain(checkEnvVars);
    expect(getDoctorChecks(false)).toContain(checkEnvVars);
  });
});

describe("Apple-native framework routing", () => {
  test("keeps a pure macOS application on native Clerk checks", async () => {
    let nativeChecks = false;
    const results = await runChecks(
      DOCTOR_CONTEXT,
      {},
      {
        dependencies: runDependencies({
          inspectIOSProject: async () => MACOS_INSPECTION,
          getDoctorChecks: (native) => {
            nativeChecks = native;
            return [async () => passingResult("Common")];
          },
          runIOSDoctorChecks: async (_ctx, options) => ({
            inspection: options.preparedInspection ?? MACOS_INSPECTION,
            results: [passingResult("macOS")],
          }),
        }),
      },
    );

    expect(nativeChecks).toBeTrue();
    expect(results.map((result) => result.name)).toEqual(["Common", "macOS"]);
  });

  test("uses ordinary checks for an unsupported Xcode-only project", async () => {
    let nativeChecks = true;
    let nativeAuditCalls = 0;
    const results = await runChecks(
      DOCTOR_CONTEXT,
      {},
      {
        dependencies: runDependencies({
          inspectIOSProject: async () => UNSUPPORTED_XCODE_INSPECTION,
          getDoctorChecks: (native) => {
            nativeChecks = native;
            return [async () => passingResult(native ? "Native" : "Environment variables")];
          },
          runIOSDoctorChecks: async () => {
            nativeAuditCalls++;
            return { inspection: UNSUPPORTED_XCODE_INSPECTION, results: [] };
          },
        }),
      },
    );

    expect(nativeChecks).toBeFalse();
    expect(nativeAuditCalls).toBe(0);
    expect(results.map((result) => result.name)).toEqual(["Environment variables"]);
  });

  test("routes a missing explicit target through the native audit", async () => {
    let nativeChecks = false;
    let nativeAuditCalls = 0;
    const results = await runChecks(
      DOCTOR_CONTEXT,
      { target: "MissingApp" },
      {
        dependencies: runDependencies({
          inspectIOSProject: async () => MISSING_TARGET_INSPECTION,
          getDoctorChecks: (native) => {
            nativeChecks = native;
            return [async () => passingResult("Common")];
          },
          runIOSDoctorChecks: async (_ctx, options) => {
            nativeAuditCalls++;
            expect(options.preparedInspection).toBe(MISSING_TARGET_INSPECTION);
            return {
              inspection: MISSING_TARGET_INSPECTION,
              results: [
                {
                  name: "iOS: Select the iOS application target",
                  status: "fail",
                  message: 'The requested target "MissingApp" was not found.',
                },
              ],
            };
          },
        }),
      },
    );

    expect(nativeChecks).toBeTrue();
    expect(nativeAuditCalls).toBe(1);
    expect(results.some((result) => result.status === "fail")).toBeTrue();
  });
});
describe("doctor telemetry stages", () => {
  test("reports the ordered native diagnostic boundaries", async () => {
    const stage = spyOn(telemetryMod, "setTelemetryStage");
    try {
      await runChecks(DOCTOR_CONTEXT, { target: "MyApp" }, { dependencies: runDependencies() });

      expect(stage.mock.calls.map((call) => call[0])).toEqual([
        "doctor_checks",
        "doctor_ios_audit",
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
});
