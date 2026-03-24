import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tanstackStart } from "./tanstack-start.ts";
import type { ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "@tanstack/react-start",
      name: "TanStack Start",
      sdk: "@clerk/tanstack-react-start",
      envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    },
    typescript: true,
    srcDir: true,
    packageManager: "npm",
    existingClerk: false,
    deps: { "@tanstack/react-start": "1.0.0" },
    envFile: ".env",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-tanstack-start-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("uses app routes when an app tree is detected", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/start.tsx"),
    `import { createStart } from "@tanstack/react-start";

export const start = createStart(() => {
  return {};
});
`,
  );

  const plan = await tanstackStart.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "app/routes/sign-in.$.tsx")).toBe(true);
  expect(plan.actions.some((action) => action.path === "app/routes/sign-up.$.tsx")).toBe(true);
  expect(plan.actions.some((action) => action.path === "src/routes/sign-in.$.tsx")).toBe(false);
});

test("places auth routes inside {-$locale} when locale dir detected", async () => {
  await mkdir(join(tempDir, "src/routes/{-$locale}"), { recursive: true });
  await Bun.write(join(tempDir, "src/routes/{-$locale}/index.tsx"), "export default function() {}");

  const plan = await tanstackStart.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "src/routes/{-$locale}/sign-in.$.tsx")).toBe(
    true,
  );
  expect(plan.actions.some((action) => action.path === "src/routes/{-$locale}/sign-up.$.tsx")).toBe(
    true,
  );
});

test("does not use locale dir when none detected", async () => {
  await mkdir(join(tempDir, "src/routes"), { recursive: true });
  await Bun.write(join(tempDir, "src/routes/index.tsx"), "export default function() {}");

  const plan = await tanstackStart.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "src/routes/sign-in.$.tsx")).toBe(true);
  expect(plan.actions.some((action) => action.path === "src/routes/sign-up.$.tsx")).toBe(true);
});
