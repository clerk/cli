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
      envFile: ".env.local",
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

test("handles chained createApp().mount() pattern from create-vite", async () => {
  await mkdir(join(tempDir, "src"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/main.ts"),
    `import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";

createApp(App).mount("#app");
`,
  );

  const plan = await vue.scaffold(makeCtx());

  const entry = findAction(plan.actions, "src/main.ts");
  expect(entry.type).toBe("modify");
  if (entry.type === "modify") {
    expect(entry.content).toContain("clerkPlugin");
    expect(entry.content).toContain("app.use(clerkPlugin");
    expect(entry.content).toContain('.mount("#app")');
    // Should split chained call into separate statements
    expect(entry.content).toContain("const app = createApp(App)");
    expect(entry.content).not.toContain("createApp(App).mount");
  }
});

test("creates entry file when none exists", async () => {
  const plan = await vue.scaffold(makeCtx());

  const entry = findAction(plan.actions, "src/main.ts");
  expect(entry.type).toBe("create");
  if (entry.type === "create") {
    expect(entry.content).toContain("clerkPlugin");
    expect(entry.content).toContain("@clerk/vue");
    expect(entry.content).toContain("PUBLISHABLE_KEY");
    expect(entry.content).toContain('.mount("#app")');
  }

  // Auth pages and env should still be scaffolded
  expect(findAction(plan.actions, "src/views/sign-in.vue").type).toBe("create");
  expect(findAction(plan.actions, "src/views/sign-up.vue").type).toBe("create");
  expect(findAction(plan.actions, ".env").type).toBe("modify");

  // No post-instruction about entry file since it was created
  expect(plan.postInstructions.some((i) => i.includes("@clerk/vue"))).toBe(false);
});

test("creates sign-in and sign-up pages", async () => {
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

  const signIn = findAction(plan.actions, "src/views/sign-in.vue");
  expect(signIn.type).toBe("create");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("<SignIn />");
    expect(signIn.content).toContain('@clerk/vue"');
    expect(signIn.content).toContain("<script setup>");
    expect(signIn.content).toContain("<template>");
  }

  const signUp = findAction(plan.actions, "src/views/sign-up.vue");
  expect(signUp.type).toBe("create");
  if (signUp.type === "create") {
    expect(signUp.content).toContain("<SignUp />");
    expect(signUp.content).toContain('@clerk/vue"');
  }
});

test("skips auth pages when they already exist", async () => {
  await mkdir(join(tempDir, "src/views"), { recursive: true });
  await Bun.write(join(tempDir, "src/views/sign-in.vue"), "<template>existing</template>");
  await Bun.write(join(tempDir, "src/views/sign-up.vue"), "<template>existing</template>");

  const plan = await vue.scaffold(makeCtx());

  expect(findAction(plan.actions, "src/views/sign-in.vue")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
  expect(findAction(plan.actions, "src/views/sign-up.vue")).toMatchObject({
    type: "skip",
    skipReason: "Sign-up page already exists",
  });
});

test("scaffolds env vars with VITE_ prefix", async () => {
  const plan = await vue.scaffold(makeCtx());

  const envAction = findAction(plan.actions, ".env");
  expect(envAction.type).toBe("modify");
  if (envAction.type === "modify") {
    expect(envAction.content).toContain("VITE_CLERK_SIGN_IN_URL");
    expect(envAction.content).toContain("VITE_CLERK_SIGN_UP_URL");
  }
});

test("uses tailwind classes when tailwindcss is a dependency", async () => {
  const plan = await vue.scaffold(makeCtx({ deps: { tailwindcss: "^3.0.0" } }));

  const signIn = findAction(plan.actions, "src/views/sign-in.vue");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("flex min-h-screen items-center justify-center");
  }
});

test("uses inline styles when no tailwind", async () => {
  const plan = await vue.scaffold(makeCtx());

  const signIn = findAction(plan.actions, "src/views/sign-in.vue");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("style=");
    expect(signIn.content).not.toContain("class=");
  }
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

  // Auth pages should be at views/ (no src/ prefix)
  expect(findAction(plan.actions, "views/sign-in.vue").type).toBe("create");
  expect(findAction(plan.actions, "views/sign-up.vue").type).toBe("create");
});

test("includes vue-router post-instruction only when vue-router is a dep", async () => {
  const withRouter = await vue.scaffold(makeCtx({ deps: { "vue-router": "^4.0.0" } }));
  expect(withRouter.postInstructions.some((i) => i.includes("Vue Router"))).toBe(true);

  const withoutRouter = await vue.scaffold(makeCtx());
  expect(withoutRouter.postInstructions.some((i) => i.includes("Vue Router"))).toBe(false);
});

test("modifies router file to add sign-in and sign-up routes", async () => {
  await mkdir(join(tempDir, "src/router"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/router/index.ts"),
    `import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
  ],
});

export default router;
`,
  );

  const plan = await vue.scaffold(makeCtx({ deps: { "vue-router": "^4.0.0" } }));

  const routerAction = findAction(plan.actions, "src/router/index.ts");
  expect(routerAction.type).toBe("modify");
  if (routerAction.type === "modify") {
    expect(routerAction.content).toContain("/sign-in");
    expect(routerAction.content).toContain("/sign-up");
    expect(routerAction.content).toContain("../views/sign-in.vue");
  }

  // No post-instruction since router was modified
  expect(plan.postInstructions.some((i) => i.includes("Vue Router"))).toBe(false);
});

test("skips router when sign routes already exist", async () => {
  await mkdir(join(tempDir, "src/router"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/router/index.ts"),
    `import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  routes: [
    { path: "/sign-in", component: () => import("../views/sign-in.vue") },
    { path: "/sign-up", component: () => import("../views/sign-up.vue") },
  ],
});

export default router;
`,
  );

  const plan = await vue.scaffold(makeCtx({ deps: { "vue-router": "^4.0.0" } }));

  expect(findAction(plan.actions, "src/router/index.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has sign-in/sign-up routes",
  });
});

test("skips router when only one sign route exists (no duplication)", async () => {
  await mkdir(join(tempDir, "src/router"), { recursive: true });
  await Bun.write(
    join(tempDir, "src/router/index.ts"),
    `import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  routes: [
    { path: "/sign-in", component: () => import("../views/sign-in.vue") },
  ],
});

export default router;
`,
  );

  const plan = await vue.scaffold(makeCtx({ deps: { "vue-router": "^4.0.0" } }));

  expect(findAction(plan.actions, "src/router/index.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has sign-in/sign-up routes",
  });
});
