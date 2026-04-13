import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nextjsPages } from "./nextjs-pages.ts";
import type { FileAction, ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "next",
      name: "Next.js",
      sdk: "@clerk/nextjs",
      envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
    },
    variant: "pages-router",
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    layoutPath: null,
    envFile: ".env.local",
    middlewareBasename: "middleware",
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
  tempDir = await mkdtemp(join(tmpdir(), "clerk-nextjs-pages-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffolds all actions for a fresh Next.js Pages Router project", async () => {
  const plan = await nextjsPages.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(5);

  // Middleware
  const mw = findAction(plan.actions, "middleware.ts");
  expect(mw.type).toBe("create");
  if (mw.type === "create") {
    expect(mw.content).toContain("clerkMiddleware");
    expect(mw.content).toContain("createRouteMatcher");
  }

  // _app (created from template when no existing file)
  const app = findAction(plan.actions, "pages/_app.tsx");
  expect(app.type).toBe("create");
  if (app.type === "create") {
    expect(app.content).toContain("ClerkProvider");
    expect(app.content).toContain("AppProps");
    expect(app.content).toContain("pageProps");
  }

  // Auth pages
  const signIn = findAction(plan.actions, "pages/sign-in/[[...sign-in]].tsx");
  expect(signIn.type).toBe("create");
  if (signIn.type === "create") {
    expect(signIn.content).toContain("SignIn");
  }

  const signUp = findAction(plan.actions, "pages/sign-up/[[...sign-up]].tsx");
  expect(signUp.type).toBe("create");

  // Env vars
  const env = findAction(plan.actions, ".env.local");
  expect(env.type).toBe("modify");
  if (env.type === "modify") {
    expect(env.content).toContain("NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in");
    expect(env.content).toContain("NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up");
  }
});

test("modifies existing _app by wrapping Component with ClerkProvider", async () => {
  await mkdir(join(tempDir, "pages"), { recursive: true });
  await Bun.write(
    join(tempDir, "pages/_app.tsx"),
    `export default function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
  );

  const plan = await nextjsPages.scaffold(makeCtx({ layoutPath: "pages/_app.tsx" }));

  const app = findAction(plan.actions, "pages/_app.tsx");
  expect(app.type).toBe("modify");
  if (app.type === "modify") {
    expect(app.content).toContain("ClerkProvider");
    expect(app.content).toContain("@clerk/nextjs");
    expect(app.content).toContain("<Component");
  }
});

test("skips _app when already has ClerkProvider", async () => {
  await mkdir(join(tempDir, "pages"), { recursive: true });
  await Bun.write(
    join(tempDir, "pages/_app.tsx"),
    `import { ClerkProvider } from "@clerk/nextjs";
export default function MyApp({ Component, pageProps }) {
  return <ClerkProvider><Component {...pageProps} /></ClerkProvider>;
}
`,
  );

  const plan = await nextjsPages.scaffold(makeCtx({ layoutPath: "pages/_app.tsx" }));

  expect(findAction(plan.actions, "pages/_app.tsx")).toMatchObject({
    type: "skip",
    skipReason: "Already has ClerkProvider",
  });
});

test("skips middleware when already has Clerk", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { clerkMiddleware } from "@clerk/nextjs/server";\nexport default clerkMiddleware();`,
  );

  const plan = await nextjsPages.scaffold(makeCtx());

  expect(findAction(plan.actions, "middleware.ts")).toMatchObject({
    type: "skip",
    skipReason: "Already has Clerk middleware",
  });
});

test("skips auth page when it already exists", async () => {
  await mkdir(join(tempDir, "pages/sign-in/[[...sign-in]]"), { recursive: true });
  await Bun.write(
    join(tempDir, "pages/sign-in/[[...sign-in]].tsx"),
    "export default function() {}",
  );

  const plan = await nextjsPages.scaffold(makeCtx());

  expect(findAction(plan.actions, "pages/sign-in/[[...sign-in]].tsx")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
});

test("adds i18n post-instruction when next-intl detected", async () => {
  const plan = await nextjsPages.scaffold(makeCtx({ deps: { "next-intl": "3.0.0" } }));

  expect(plan.postInstructions.some((i) => i.includes("i18n"))).toBe(true);
});

test("adds i18n post-instruction when next-i18next detected", async () => {
  const plan = await nextjsPages.scaffold(makeCtx({ deps: { "next-i18next": "14.0.0" } }));

  expect(plan.postInstructions.some((i) => i.includes("i18n"))).toBe(true);
});

test("no i18n instruction without i18n deps", async () => {
  const plan = await nextjsPages.scaffold(makeCtx({ deps: {} }));

  expect(plan.postInstructions).toHaveLength(0);
});

test("uses .jsx extension when typescript is false", async () => {
  const plan = await nextjsPages.scaffold(makeCtx({ typescript: false }));

  findAction(plan.actions, "middleware.js");

  const app = findAction(plan.actions, "pages/_app.jsx");
  expect(app.type).toBe("create");
  if (app.type === "create") {
    expect(app.content).not.toContain("AppProps");
  }

  findAction(plan.actions, "pages/sign-in/[[...sign-in]].jsx");
  findAction(plan.actions, "pages/sign-up/[[...sign-up]].jsx");
});

test("uses src/ paths when srcDir is true", async () => {
  const plan = await nextjsPages.scaffold(makeCtx({ srcDir: true }));

  findAction(plan.actions, "src/middleware.ts");
  findAction(plan.actions, "src/pages/_app.tsx");
  findAction(plan.actions, "src/pages/sign-in/[[...sign-in]].tsx");
  findAction(plan.actions, "src/pages/sign-up/[[...sign-up]].tsx");
});
