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

test("creates src/start.ts with clerkMiddleware when no start file exists", async () => {
  const plan = await tanstackStart.scaffold(makeCtx());

  const serverAction = plan.actions.find((action) => action.path === "src/start.ts");
  expect(serverAction).toBeDefined();
  expect(serverAction?.type).toBe("create");
  if (serverAction?.type === "create") {
    expect(serverAction.content).toContain("clerkMiddleware");
    expect(serverAction.content).toContain("@clerk/tanstack-react-start/server");
    expect(serverAction.content).toContain("requestMiddleware");
  }
});

test("creates app/start.ts when no start file exists and app base dir is detected", async () => {
  await mkdir(join(tempDir, "app/routes"), { recursive: true });
  await Bun.write(join(tempDir, "app/routes/__root.tsx"), "export default function Root() {}");

  const plan = await tanstackStart.scaffold(makeCtx());

  const serverAction = plan.actions.find((action) => action.path === "app/start.ts");
  expect(serverAction).toBeDefined();
  expect(serverAction?.type).toBe("create");
  if (serverAction?.type === "create") {
    expect(serverAction.content).toContain("clerkMiddleware");
    expect(serverAction.content).toContain("requestMiddleware");
  }
});

test("does not emit a post-instruction to add middleware when start file is missing", async () => {
  const plan = await tanstackStart.scaffold(makeCtx());

  expect(plan.postInstructions.some((msg) => msg.toLowerCase().includes("requestmiddleware"))).toBe(
    false,
  );
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

test("prefers start file in baseDir over other directories", async () => {
  // Both src/start.ts and app/routes/__root.tsx exist.
  // baseDir resolves to "app" from __root.tsx, so app/start.ts should be
  // patched (or created), not src/start.ts.
  await mkdir(join(tempDir, "app/routes"), { recursive: true });
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(join(tempDir, "app/routes/__root.tsx"), "export default function Root() {}");
  await Bun.write(
    join(tempDir, "src/start.ts"),
    `import { createStart } from "@tanstack/react-start";
export const start = createStart(() => { return {}; });
`,
  );

  const plan = await tanstackStart.scaffold(makeCtx());

  // Should create app/start.ts, not modify src/start.ts
  const appStart = plan.actions.find((a) => a.path === "app/start.ts");
  const srcStart = plan.actions.find((a) => a.path === "src/start.ts");
  expect(appStart).toBeDefined();
  expect(appStart?.type).toBe("create");
  expect(srcStart).toBeUndefined();
});

test("does not use locale dir when none detected", async () => {
  await mkdir(join(tempDir, "src/routes"), { recursive: true });
  await Bun.write(join(tempDir, "src/routes/index.tsx"), "export default function() {}");

  const plan = await tanstackStart.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "src/routes/sign-in.$.tsx")).toBe(true);
  expect(plan.actions.some((action) => action.path === "src/routes/sign-up.$.tsx")).toBe(true);
});
