import { test, expect } from "bun:test";
import { ios } from "./ios.ts";
import type { ProjectContext } from "./types.ts";

function makeCtx(): ProjectContext {
  return {
    cwd: "/tmp/ios-app",
    framework: {
      dep: "ios",
      name: "iOS (Swift)",
      sdk: "ClerkKit",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "swift" as const,
    },
    typescript: false,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    envFile: ".env",
  };
}

test("matches only the ios framework", () => {
  const ctx = makeCtx();
  expect(ios.matches(ctx)).toBe(true);
  expect(ios.matches({ ...ctx, framework: { ...ctx.framework, dep: "android" } })).toBe(false);
});

test("writes no files and prints the quickstart steps", async () => {
  const plan = await ios.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("github.com/clerk/clerk-ios"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("ClerkKit") && i.includes("ClerkKitUI")),
  ).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("dashboard.clerk.com/~/native-applications")),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Clerk.configure"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("docs/ios/getting-started/quickstart"))).toBe(
    true,
  );
});

test("references the project's env file for the publishable key", async () => {
  const plan = await ios.scaffold({ ...makeCtx(), envFile: ".env.local" });

  expect(plan.postInstructions.some((i) => i.includes(".env.local"))).toBe(true);
});
