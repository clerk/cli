import { test, expect } from "bun:test";
import { android } from "./android.ts";
import type { ProjectContext } from "./types.ts";

function makeCtx(): ProjectContext {
  return {
    cwd: "/tmp/android-app",
    framework: {
      dep: "android",
      name: "Android (Kotlin)",
      sdk: "com.clerk:clerk-android-ui",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "gradle" as const,
    },
    typescript: false,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    envFile: ".env",
  };
}

test("matches only the android framework", () => {
  const ctx = makeCtx();
  expect(android.matches(ctx)).toBe(true);
  expect(android.matches({ ...ctx, framework: { ...ctx.framework, dep: "ios" } })).toBe(false);
});

test("writes no files and prints the quickstart steps", async () => {
  const plan = await android.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("com.clerk:clerk-android-ui"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("dashboard.clerk.com/~/native-applications")),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Clerk.initialize"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("android.permission.INTERNET"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("docs/android/getting-started/quickstart")),
  ).toBe(true);
});

test("references the project's env file for the publishable key", async () => {
  const plan = await android.scaffold({ ...makeCtx(), envFile: ".env.local" });

  expect(plan.postInstructions.some((i) => i.includes(".env.local"))).toBe(true);
});
