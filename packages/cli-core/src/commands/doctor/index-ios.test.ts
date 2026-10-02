import { expect, test } from "bun:test";
import { getDoctorChecks, runChecks, type DoctorRunDependencies } from "./index.ts";
import { checkEnvVars } from "./checks.ts";
import type { DoctorContext } from "./types.ts";

const ctx = {} as DoctorContext;
function dependencies(native = true): DoctorRunDependencies {
  return {
    detectFramework: async () => ({ dep: native ? "ios" : "react" }) as never,
    getDoctorChecks: (apple) => {
      expect(apple).toBe(native);
      return [
        { name: "Common", run: async () => ({ name: "Common", status: "pass", message: "ok" }) },
      ];
    },
    runIOSDoctorChecks: async () => ({
      results: [{ name: "Native", status: "warn", message: "Build the app" }],
    }),
  };
}
test("native diagnostics replace web env-file checks", () => {
  expect(getDoctorChecks(true).map((check) => check.run)).not.toContain(checkEnvVars);
  expect(getDoctorChecks(false).map((check) => check.run)).toContain(checkEnvVars);
});
test("Apple projects use native checks; web projects retain their existing checks", async () => {
  expect(
    (await runChecks(ctx, {}, { dependencies: dependencies() })).map((item) => item.name),
  ).toEqual(["Common", "Native"]);
  expect(
    (await runChecks(ctx, {}, { dependencies: dependencies(false) })).map((item) => item.name),
  ).toEqual(["Common"]);
});
test("an explicit target bypasses framework ambiguity and reaches the selected native target", async () => {
  const deps = dependencies();
  deps.detectFramework = async () => {
    throw new Error("should not detect");
  };
  deps.runIOSDoctorChecks = async (_ctx, options) => {
    expect(options).toMatchObject({
      target: "MyApp",
      configuration: "Staging",
      project: "App.xcodeproj",
    });
    return { results: [] };
  };
  expect(
    await runChecks(
      ctx,
      { target: "MyApp", configuration: "Staging", project: "App.xcodeproj" },
      { dependencies: deps },
    ),
  ).toHaveLength(1);
});
test("a failed native inspection retains account diagnostics and gives a failing result", async () => {
  const deps = dependencies();
  deps.runIOSDoctorChecks = async () => {
    throw new Error("Xcode failed");
  };
  expect(await runChecks(ctx, {}, { dependencies: deps })).toMatchObject([
    { name: "Common" },
    { name: "Apple-native inspection", status: "fail" },
  ]);
});
