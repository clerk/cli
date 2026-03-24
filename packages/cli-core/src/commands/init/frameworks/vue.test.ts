import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { vue } from "./vue.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "vue",
      name: "Vue",
      sdk: "@clerk/vue",
      envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    },
    typescript: true,
    srcDir: true,
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
  tempDir = await mkdtemp(join(tmpdir(), "clerk-vue-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("modifies entry file for a fresh Vue project", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.ts"),
    `import { createApp } from "vue";
import App from "./App.vue";

const app = createApp(App);
app.mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx());

  const entry = findAction(plan.actions, "src/main.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("clerkPlugin");
    expect(entry.content).toContain("@clerk/vue");
    expect(entry.content).toContain("PUBLISHABLE_KEY");
    expect(entry.content).toContain("app.use(clerkPlugin");
    expect(entry.content).toContain('.mount("#app")');
  }
});

test("skips when entry already has clerkPlugin", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.ts"),
    `import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
const app = createApp(App);
app.use(clerkPlugin, { publishableKey: "pk_test_123" });
app.mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/main.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has Clerk plugin",
  });
});

test("skips when entry already imports @clerk/vue", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.ts"),
    `import { createApp } from "vue";
import something from "@clerk/vue";
const app = createApp(App);
app.mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/main.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has Clerk plugin",
  });
});

test("returns empty actions with post-instruction when no entry file found", async () => {
  const plan = await vue.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions.some((i) => i.includes("@clerk/vue"))).toBe(true);
});

test("uses main.js when typescript is false", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.js"),
    `import { createApp } from "vue";
import App from "./App.vue";
const app = createApp(App);
app.mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx({ typescript: false }));

  const entry = findAction(plan.actions, "src/main.js");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("clerkPlugin");
  }
});

test("finds root main.ts when srcDir is false", async () => {
  await Bun.write(
    join(tempDir, "main.ts"),
    `import { createApp } from "vue";
import App from "./App.vue";
const app = createApp(App);
app.mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx({ srcDir: false }));

  const entry = findAction(plan.actions, "main.ts");
  expect(entry.type).toBe("modify");
});
