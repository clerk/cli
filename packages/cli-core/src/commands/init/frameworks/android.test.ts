import { test, expect } from "bun:test";
import { android, androidManualSteps } from "./android.ts";
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

test("without an application, points at the continuation that sets the module up", async () => {
  const plan = await android.scaffold({
    ...makeCtx(),
    nativeContinuation: "clerk init --app <app_id> --json --android-module app",
  });

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions[0]).toContain("once it knows which Clerk application");
  expect(plan.postInstructions.some((i) => i.includes("clerk apps list --json"))).toBe(true);
  expect(
    plan.postInstructions.some((i) =>
      i.includes("`clerk init --app <app_id> --json --android-module app`"),
    ),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("clerk env pull"))).toBe(false);
  expect(
    plan.postInstructions.some((i) => i.includes("docs/android/getting-started/quickstart")),
  ).toBe(true);
});

test("when native setup refused the layout, prints the reason and the manual quickstart steps", async () => {
  const plan = await android.scaffold({
    ...makeCtx(),
    envFile: ".env.local",
    nativeFallback: "the build declares product flavors.",
  });

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions[0]).toContain("the build declares product flavors.");
  expect(plan.postInstructions.slice(1)).toEqual(androidManualSteps(".env.local"));
  expect(plan.postInstructions.some((i) => i.includes("com.clerk:clerk-android-api"))).toBe(true);
  expect(
    plan.postInstructions.some((i) => i.includes("dashboard.clerk.com/~/native-applications")),
  ).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("Clerk.initialize"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes("android.permission.INTERNET"))).toBe(true);
  expect(plan.postInstructions.some((i) => i.includes(".env.local"))).toBe(true);
});
