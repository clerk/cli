import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { astro } from "./astro.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "astro",
      name: "Astro",
      sdk: "@clerk/astro",
      envVar: "PUBLIC_CLERK_PUBLISHABLE_KEY",
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    envFile: ".env",
    ...overrides,
  };
}

function findAction(actions: FileAction[], path: string): FileAction {
  const action = actions.find((a) => a.path === path);
  if (!action) {
    const paths = actions.map((a) => a.path).join(", ");
    throw new Error(`No action found for path "${path}". Available: ${paths}`);
  }
  return action;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-astro-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffolds all actions for a fresh Astro project", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [],
});
`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(5);

  const config = findAction(plan.actions, "astro.config.mjs");
  expect(config.type).toBe("modify");
  if (config.type === "modify") {
    expect(config.content).toContain("clerk");
    expect(config.content).toContain("@clerk/astro");
  }

  const mw = findAction(plan.actions, "src/middleware.ts");
  expect(mw.type).toBe("create");
  if (mw.type === "create") {
    expect(mw.content).toContain("clerkMiddleware");
    expect(mw.content).toContain("onRequest");
  }

  const signIn = findAction(plan.actions, "src/pages/sign-in.astro");
  expect(signIn.type).toBe("create");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("SignIn");
  }

  const signUp = findAction(plan.actions, "src/pages/sign-up.astro");
  expect(signUp.type).toBe("create");

  const env = findAction(plan.actions, ".env");
  expect(env.type).toBe("modify");
  if (env.type === "modify") {
    expect(env.content).toContain("PUBLIC_CLERK_SIGN_IN_URL=/sign-in");
    expect(env.content).toContain("PUBLIC_CLERK_SIGN_UP_URL=/sign-up");
  }

  // Always includes SSR adapter post-instruction
  expect(plan.postInstructions.some((i) => i.includes("output: 'server'"))).toBe(true);
});

test("skips config when @clerk/astro already present", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
import clerk from "@clerk/astro";

export default defineConfig({
  integrations: [clerk()],
});
`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, "astro.config.mjs")).toMatchObject({
    type: "skip",
    skipReason: "Already has @clerk/astro integration",
  });
});

test("skips config when no config file found", async () => {
  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, "astro.config.mjs")).toMatchObject({
    type: "skip",
  });
  const action = findAction(plan.actions, "astro.config.mjs");
  if (action.type === "skip") {
    expect(action.skipReason).toContain("No Astro config file found");
  }
});

test("skips middleware when already has Clerk", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
export default defineConfig({ integrations: [] });
`,
  );
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/middleware.ts"),
    `import { clerkMiddleware } from "@clerk/astro/server";
export const onRequest = clerkMiddleware();
`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/middleware.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has Clerk middleware",
  });
});

test("skips middleware when existing non-Clerk middleware found", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
export default defineConfig({ integrations: [] });
`,
  );
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/middleware.ts"),
    `export const onRequest = (context, next) => {
  return next();
};
`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/middleware.ts")).toMatchObject({
    type: "skip",
    skipReason: "Existing middleware found — add clerkMiddleware() manually",
  });
});

test("skips auth page when it already exists", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
export default defineConfig({ integrations: [] });
`,
  );
  await mkdir(join(tempDir, "src/pages"), { recursive: true });
  await Bun.write(join(tempDir, "src/pages/sign-in.astro"), "---\n---\n<div>existing</div>");

  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/pages/sign-in.astro")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
});

test("skips env vars when already set", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
export default defineConfig({ integrations: [] });
`,
  );
  await Bun.write(
    join(tempDir, ".env"),
    `PUBLIC_CLERK_SIGN_IN_URL=/sign-in\nPUBLIC_CLERK_SIGN_UP_URL=/sign-up\n`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(findAction(plan.actions, ".env")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in/sign-up route vars already set",
  });
});

test("adds i18n post-instruction when i18n config detected", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [],
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es"],
  },
});
`,
  );

  const plan = await astro.scaffold(makeCtx());

  expect(plan.postInstructions.some((i) => i.includes("locale"))).toBe(true);
});

test("no i18n post-instruction without i18n config", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [],
});
`,
  );

  const plan = await astro.scaffold(makeCtx());

  // The only post-instruction should be about SSR, not i18n
  expect(plan.postInstructions.some((i) => i.includes("locale"))).toBe(false);
});

test("uses .js extension when typescript is false", async () => {
  await Bun.write(
    join(tempDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
export default defineConfig({ integrations: [] });
`,
  );

  const plan = await astro.scaffold(makeCtx({ typescript: false }));

  findAction(plan.actions, "src/middleware.js");
});
