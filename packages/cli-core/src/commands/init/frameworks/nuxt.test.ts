import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nuxt } from "./nuxt.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "nuxt",
      name: "Nuxt",
      sdk: "@clerk/nuxt",
      envVar: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
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
  tempDir = await mkdtemp(join(tmpdir(), "clerk-nuxt-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffolds all actions for a fresh Nuxt project", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({
  modules: [],
});
`,
  );

  const plan = await nuxt.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(4);

  const config = findAction(plan.actions, "nuxt.config.ts");
  expect(config.type).toBe("modify");
  if (config.type === "modify") {
    expect(config.content).toContain("@clerk/nuxt");
  }

  const signIn = findAction(plan.actions, "pages/sign-in.vue");
  expect(signIn.type).toBe("create");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("<template>");
    expect(signIn.content).toContain("SignIn");
  }

  const signUp = findAction(plan.actions, "pages/sign-up.vue");
  expect(signUp.type).toBe("create");

  const env = findAction(plan.actions, ".env");
  expect(env.type).toBe("modify");
  if (env.type === "modify") {
    expect(env.content).toContain("NUXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in");
    expect(env.content).toContain("NUXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up");
  }

  expect(plan.postInstructions.length).toBeGreaterThanOrEqual(1);
});

test("skips config when @clerk/nuxt already present", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({
  modules: ['@clerk/nuxt'],
});
`,
  );

  const plan = await nuxt.scaffold(makeCtx());

  expect(findAction(plan.actions, "nuxt.config.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has @clerk/nuxt module",
  });
});

test("skips config when no config file found", async () => {
  const plan = await nuxt.scaffold(makeCtx());

  expect(findAction(plan.actions, "nuxt.config.ts")).toMatchObject({
    type: "skip",
  });
  const action = findAction(plan.actions, "nuxt.config.ts");
  if (action.type === "skip") {
    expect(action.skipReason).toContain("No Nuxt config file found");
  }
});

test("skips auth page when it already exists", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({ modules: [] });`,
  );
  await mkdir(join(tempDir, "pages"), { recursive: true });
  await Bun.write(join(tempDir, "pages/sign-in.vue"), "<template><div>existing</div></template>");

  const plan = await nuxt.scaffold(makeCtx());

  expect(findAction(plan.actions, "pages/sign-in.vue")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
});

test("skips env vars when already set", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({ modules: [] });`,
  );
  await Bun.write(
    join(tempDir, ".env"),
    `NUXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in\nNUXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up\n`,
  );

  const plan = await nuxt.scaffold(makeCtx());

  expect(findAction(plan.actions, ".env")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in/sign-up route vars already set",
  });
});

test("adds i18n post-instruction when @nuxtjs/i18n detected", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({ modules: [] });`,
  );

  const plan = await nuxt.scaffold(makeCtx({ deps: { "@nuxtjs/i18n": "8.0.0" } }));

  expect(plan.postInstructions.some((i) => i.includes("@nuxtjs/i18n"))).toBe(true);
});

test("no i18n instruction without @nuxtjs/i18n", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.ts"),
    `export default defineNuxtConfig({ modules: [] });`,
  );

  const plan = await nuxt.scaffold(makeCtx({ deps: {} }));

  expect(plan.postInstructions.some((i) => i.includes("@nuxtjs/i18n"))).toBe(false);
});

test("handles nuxt.config.js variant", async () => {
  await Bun.write(
    join(tempDir, "nuxt.config.js"),
    `export default defineNuxtConfig({
  modules: [],
});
`,
  );

  const plan = await nuxt.scaffold(makeCtx());

  const config = findAction(plan.actions, "nuxt.config.js");
  expect(config.type).toBe("modify");
});
