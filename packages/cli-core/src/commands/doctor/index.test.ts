import { describe, expect, test } from "bun:test";
import { checkEnvVars } from "./checks.ts";
import { getDoctorChecks, validateDoctorOptions } from "./index.ts";

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
