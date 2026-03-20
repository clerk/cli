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
  expect(plan.actions[0]!.type).not.toBe("skip");

  // Layout
  expect(plan.actions[1]!.path).toBe("app/layout.tsx");
  expect(plan.actions[1]!.type).toBe("modify");

  // Sign-in
  expect(plan.actions[2]!.path).toBe("app/sign-in/[[...sign-in]]/page.tsx");
  expect(plan.actions[2]!.type).toBe("create");

  // Sign-up
  expect(plan.actions[3]!.path).toBe("app/sign-up/[[...sign-up]]/page.tsx");
  expect(plan.actions[3]!.type).toBe("create");
});

test("skips middleware when already has Clerk", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { clerkMiddleware } from "@clerk/nextjs/server";\nexport default clerkMiddleware();`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[0]).toMatchObject({
    type: "skip",
    skipReason: "Already has Clerk middleware",
  });
});

test("skips layout when already has ClerkProvider", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/layout.tsx"),
    `import { ClerkProvider } from "@clerk/nextjs";\nexport default function L({ children }) { return <ClerkProvider>{children}</ClerkProvider>; }`,
  );

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[1]).toMatchObject({
    type: "skip",
    skipReason: "Already has ClerkProvider",
  });
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

  expect(plan.actions[2]).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
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

test("returns skip action when no layout found", async () => {
  const plan = await nextjsApp.scaffold(makeCtx({ layoutPath: null }));

  expect(plan.actions[1]).toMatchObject({
    type: "skip",
    skipReason: "Layout file not found",
  });
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
  expect(plan.actions[0]!.type).not.toBe("skip");
});

test("skips unsupported middleware export shapes", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `const middleware = createMiddleware();
export default middleware;
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[0]).toMatchObject({
    type: "skip",
    skipReason: "Existing middleware uses an unsupported shape for automatic Clerk composition",
  });
});

test("skips middleware composition when config export already exists", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `export default function middleware() {
  return Response.redirect("https://example.com");
}

export const config = {
  matcher: ["/foo"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(plan.actions[0]).toMatchObject({
    type: "skip",
    skipReason: "Existing middleware uses an unsupported shape for automatic Clerk composition",
  });
});

test("adds Clerk middleware once when existing middleware has no default export", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `export function trace() {
  return "ok";
}
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const middlewareAction = plan.actions[0];

  expect(middlewareAction).toBeDefined();
  expect(middlewareAction?.type).toBe("modify");

  if (middlewareAction?.type !== "modify") {
    throw new Error("Expected middleware action to modify middleware.ts");
  }

  expect(middlewareAction.content.match(/@clerk\/nextjs\/server/g)?.length).toBe(1);
  expect(middlewareAction.content.match(/const isPublicRoute/g)?.length).toBe(1);
  expect(middlewareAction.content.match(/export const config/g)?.length).toBe(1);
});

test("uses proxy.ts when middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ middlewareBasename: "proxy" }));

  expect(plan.actions[0]!.path).toBe("proxy.ts");
});

test("uses src/proxy.ts when srcDir and middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "src/app"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ srcDir: true, layoutPath: "src/app/layout.tsx", middlewareBasename: "proxy" }),
  );

  expect(plan.actions[0]!.path).toBe("src/proxy.ts");
});
