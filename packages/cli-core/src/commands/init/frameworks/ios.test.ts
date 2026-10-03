import { afterEach, test, expect } from "bun:test";
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

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
});

test("matches only the ios framework", () => {
  const ctx = makeCtx();
  expect(ios.matches(ctx)).toBe(true);
  expect(ios.matches({ ...ctx, framework: { ...ctx.framework, dep: "android" } })).toBe(false);
});

test("on macOS, writes no files and explains how to choose an application", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const plan = await ios.scaffold(makeCtx());
  const text = plan.postInstructions.join("\n");

  expect(plan.actions).toHaveLength(0);
  expect(text).toContain("clerk apps list --json");
  expect(text).toContain("clerk apps create");
  expect(text).toContain("clerk auth login");
  expect(text).toContain("clerk init --app <app_id> --json");
  expect(text).toContain("docs/ios/getting-started/quickstart");
  expect(text).not.toContain("clerk env pull");
});

test("without Xcode, prints the manual quickstart and points at the env file", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const plan = await ios.scaffold({ ...makeCtx(), envFile: ".env.local" });
  const text = plan.postInstructions.join("\n");

  expect(plan.actions).toHaveLength(0);
  expect(text).toContain("github.com/clerk/clerk-ios");
  expect(text).toContain("Clerk.configure");
  expect(text).toContain(".env.local");
});
