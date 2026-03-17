import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nextjsApp } from "./nextjs-app.ts";
import type { ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "next",
      name: "Next.js",
      sdk: "@clerk/nextjs",
      envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    },
    variant: "app-router",
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: {},
    layoutPath: "app/layout.tsx",
    envFile: ".env.local",
    middlewareBasename: "middleware",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-nextjs-app-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffolds all 4 files for a fresh Next.js App Router project", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  );

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions).toHaveLength(4);

  // Middleware
  expect(plan.actions[0]!.path).toBe("middleware.ts");
  expect(plan.actions[0]!.type).toBe("create");
  expect(plan.actions[0]!.content).toContain("clerkMiddleware");
  expect(plan.actions[0]!.content).toContain("createRouteMatcher");
  expect(plan.actions[0]!.skipReason).toBeUndefined();

  // Layout
  expect(plan.actions[1]!.path).toBe("app/layout.tsx");
  expect(plan.actions[1]!.type).toBe("modify");
  expect(plan.actions[1]!.content).toContain("ClerkProvider");
  expect(plan.actions[1]!.content).toContain("@clerk/nextjs");

  // Sign-in
  expect(plan.actions[2]!.path).toBe("app/sign-in/[[...sign-in]]/page.tsx");
  expect(plan.actions[2]!.type).toBe("create");
  expect(plan.actions[2]!.content).toContain("<SignIn />");

  // Sign-up
  expect(plan.actions[3]!.path).toBe("app/sign-up/[[...sign-up]]/page.tsx");
  expect(plan.actions[3]!.type).toBe("create");
  expect(plan.actions[3]!.content).toContain("<SignUp />");
});

test("skips middleware when already has Clerk", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { clerkMiddleware } from "@clerk/nextjs/server";\nexport default clerkMiddleware();`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[0]!.skipReason).toBe("Already has Clerk middleware");
});

test("skips layout when already has ClerkProvider", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/layout.tsx"),
    `import { ClerkProvider } from "@clerk/nextjs";\nexport default function L({ children }) { return <ClerkProvider>{children}</ClerkProvider>; }`,
  );

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[1]!.skipReason).toBe("Already has ClerkProvider");
});

test("skips sign-in page when it already exists", async () => {
  await mkdir(join(tempDir, "app/sign-in/[[...sign-in]]"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/sign-in/[[...sign-in]]/page.tsx"),
    "export default function() {}",
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[2]!.skipReason).toBe("Sign-in page already exists");
});

test("uses src/ paths when srcDir is true", async () => {
  await mkdir(join(tempDir, "src/app"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ srcDir: true, layoutPath: "src/app/layout.tsx" }),
  );

  expect(plan.actions[0]!.path).toBe("src/middleware.ts");
  expect(plan.actions[2]!.path).toBe("src/app/sign-in/[[...sign-in]]/page.tsx");
  expect(plan.actions[3]!.path).toBe("src/app/sign-up/[[...sign-up]]/page.tsx");
});

test("uses .jsx extension when typescript is false", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.jsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ typescript: false, layoutPath: "app/layout.jsx" }),
  );

  expect(plan.actions[0]!.path).toBe("middleware.js");
  expect(plan.actions[2]!.path).toBe("app/sign-in/[[...sign-in]]/page.jsx");
});

test("adds post-instructions for sign-in/sign-up URLs", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.postInstructions.length).toBeGreaterThan(0);
  expect(plan.postInstructions.some((i) => i.includes("NEXT_PUBLIC_CLERK_SIGN_IN_URL"))).toBe(true);
});

test("adds post-instruction when no layout found", async () => {
  const plan = await nextjsApp.scaffold(makeCtx({ layoutPath: null }));

  expect(plan.postInstructions.some((i) => i.includes("ClerkProvider"))).toBe(true);
});

test("composes with existing non-Clerk middleware", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { NextResponse } from "next/server";
export default function middleware(request) {
  return NextResponse.next();
}
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[0]!.type).toBe("modify");
  expect(plan.actions[0]!.content).toContain("clerkMiddleware");
  expect(plan.actions[0]!.content).toContain("existingMiddleware");
  expect(plan.actions[0]!.skipReason).toBeUndefined();
});

test("uses proxy.ts when middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ middlewareBasename: "proxy" }));

  expect(plan.actions[0]!.path).toBe("proxy.ts");
  expect(plan.actions[0]!.content).toContain("clerkMiddleware");
});

test("uses src/proxy.ts when srcDir and middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "src/app"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ srcDir: true, layoutPath: "src/app/layout.tsx", middlewareBasename: "proxy" }),
  );

  expect(plan.actions[0]!.path).toBe("src/proxy.ts");
});
