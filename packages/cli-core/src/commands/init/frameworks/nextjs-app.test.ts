import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { nextjsApp } from "./nextjs-app.ts";
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

/** Find a scaffold action by its exact path. Throws with a clear message if not found. */
function findAction(actions: FileAction[], path: string): FileAction {
  const action = actions.find((a) => a.path === path);
  if (!action) {
    const paths = actions.map((a) => a.path).join(", ");
    throw new Error(`No action found for path "${path}". Available: ${paths}`);
  }
  return action;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-nextjs-app-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffolds all 5 actions for a fresh Next.js App Router project", async () => {
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

  expect(plan.actions).toHaveLength(5);

  // Middleware
  const mw = findAction(plan.actions, "middleware.ts");
  expect(mw.type).toBe("create");
  if (mw.type === "create") {
    // Non-i18n: should NOT have locale-prefixed patterns
    expect(mw.content).not.toContain("/:locale/");
  }

  // Layout
  const layout = findAction(plan.actions, "app/layout.tsx");
  expect(layout.type).toBe("modify");

  // Sign-in
  const signIn = findAction(plan.actions, "app/sign-in/[[...sign-in]]/page.tsx");
  expect(signIn.type).toBe("create");

  // Sign-up
  const signUp = findAction(plan.actions, "app/sign-up/[[...sign-up]]/page.tsx");
  expect(signUp.type).toBe("create");

  // Env vars
  const env = findAction(plan.actions, ".env.local");
  expect(env.type).toBe("modify");
});

test("skips middleware when already has Clerk", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { clerkMiddleware } from "@clerk/nextjs/server";\nexport default clerkMiddleware();`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(findAction(plan.actions, "middleware.ts")).toMatchObject({
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

  expect(findAction(plan.actions, "app/layout.tsx")).toMatchObject({
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

  expect(findAction(plan.actions, "app/sign-in/[[...sign-in]]/page.tsx")).toMatchObject({
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

  findAction(plan.actions, "src/middleware.ts");
  findAction(plan.actions, "src/app/sign-in/[[...sign-in]]/page.tsx");
  findAction(plan.actions, "src/app/sign-up/[[...sign-up]]/page.tsx");
});

test("uses .jsx extension when typescript is false", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.jsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ typescript: false, layoutPath: "app/layout.jsx" }),
  );

  findAction(plan.actions, "middleware.js");
  findAction(plan.actions, "app/sign-in/[[...sign-in]]/page.jsx");
});

test("writes sign-in/sign-up route env vars to env file", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  const envAction = findAction(plan.actions, ".env.local");
  expect(envAction.type).toBe("modify");
  if (envAction.type === "modify") {
    expect(envAction.content).toContain("NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in");
    expect(envAction.content).toContain("NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up");
    expect(envAction.content).toContain("NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/");
    expect(envAction.content).toContain("NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/");
  }
  expect(plan.postInstructions).toHaveLength(0);
});

test("returns skip action when no layout found", async () => {
  const plan = await nextjsApp.scaffold(makeCtx({ layoutPath: null }));

  // When layoutPath is null, the expected path is derived from the default convention
  const layoutAction = findAction(plan.actions, "app/layout.tsx");
  expect(layoutAction).toMatchObject({
    type: "skip",
    skipReason: "Layout file not found",
  });
});

test("properly indents ClerkProvider wrapping in layout", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
`,
  );

  const plan = await nextjsApp.scaffold(makeCtx());
  const layout = findAction(plan.actions, "app/layout.tsx");

  expect(layout.type).toBe("modify");
  if (layout.type === "modify") {
    // ClerkProvider should be on its own line after <body>, not inline
    expect(layout.content).not.toContain("<body><ClerkProvider>");
    expect(layout.content).not.toContain("</ClerkProvider></body>");
    // Proper nesting: <body> → <ClerkProvider> → {children} → </ClerkProvider> → </body>
    expect(layout.content).toContain("<ClerkProvider>");
    expect(layout.content).toContain("</ClerkProvider>");
    // {children} should be indented deeper than <ClerkProvider>
    const lines = layout.content.split("\n");
    const providerLine = lines.find((l) => l.includes("<ClerkProvider>"));
    const childrenLine = lines.find((l) => l.includes("{children}"));
    expect(providerLine).toBeDefined();
    expect(childrenLine).toBeDefined();
    const providerIndent = providerLine!.search(/\S/);
    const childrenIndent = childrenLine!.search(/\S/);
    expect(childrenIndent).toBeGreaterThan(providerIndent);
  }
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

  const mw = findAction(plan.actions, "middleware.ts");
  expect(mw.type).toBe("modify");
});

test("composes with expression export middleware (variable default export)", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `const middleware = createMiddleware();
export default middleware;
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  const mw = findAction(plan.actions, "middleware.ts");
  expect(mw.type).toBe("modify");
  if (mw.type === "modify") {
    // `export default middleware` is stripped (variable already named `middleware`)
    expect(mw.content).not.toContain("export default middleware");
    expect(mw.content).toContain("const middleware = createMiddleware()");
    expect(mw.content).toContain("clerkMiddleware");
    expect(mw.content).toContain("middleware(request)");
  }
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

  expect(findAction(plan.actions, "middleware.ts")).toMatchObject({
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
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("modify");
  if (mw.type !== "modify") {
    throw new Error("Expected middleware action to modify middleware.ts");
  }

  expect(mw.content.match(/@clerk\/nextjs\/server/g)?.length).toBe(1);
  expect(mw.content.match(/const isPublicRoute/g)?.length).toBe(1);
  expect(mw.content.match(/export const config/g)?.length).toBe(1);
});

test("uses proxy.ts when middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ middlewareBasename: "proxy" }));

  findAction(plan.actions, "proxy.ts");
});

test("uses src/proxy.ts when srcDir and middlewareBasename is proxy", async () => {
  await mkdir(join(tempDir, "src/app"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(
    makeCtx({ srcDir: true, layoutPath: "src/app/layout.tsx", middlewareBasename: "proxy" }),
  );

  findAction(plan.actions, "src/proxy.ts");
});

test("places auth pages inside [locale] when i18n locale dir is set", async () => {
  await mkdir(join(tempDir, "app/[locale]"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "app/[locale]/layout.tsx"), "<NextIntlClientProvider>");

  const plan = await nextjsApp.scaffold(makeCtx({ i18nLocaleDir: "[locale]" }));

  findAction(plan.actions, "app/[locale]/sign-in/[[...sign-in]]/page.tsx");
  findAction(plan.actions, "app/[locale]/sign-up/[[...sign-up]]/page.tsx");
});

test("places auth pages inside [lang] when i18n locale dir uses [lang]", async () => {
  await mkdir(join(tempDir, "app/[lang]"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "app/[lang]/layout.tsx"), "export default function() {}");

  const plan = await nextjsApp.scaffold(makeCtx({ i18nLocaleDir: "[lang]" }));

  findAction(plan.actions, "app/[lang]/sign-in/[[...sign-in]]/page.tsx");
  findAction(plan.actions, "app/[lang]/sign-up/[[...sign-up]]/page.tsx");
});

test("places auth pages inside src/app/[locale] when srcDir and i18n", async () => {
  await mkdir(join(tempDir, "src/app/[locale]"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "src/app/[locale]/layout.tsx"), "export default function() {}");

  const plan = await nextjsApp.scaffold(
    makeCtx({ srcDir: true, layoutPath: "src/app/layout.tsx", i18nLocaleDir: "[locale]" }),
  );

  findAction(plan.actions, "src/app/[locale]/sign-in/[[...sign-in]]/page.tsx");
  findAction(plan.actions, "src/app/[locale]/sign-up/[[...sign-up]]/page.tsx");
});

test("skips i18n auth page when it already exists inside [locale]", async () => {
  await mkdir(join(tempDir, "app/[locale]/sign-in/[[...sign-in]]"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/[locale]/sign-in/[[...sign-in]]/page.tsx"),
    "export default function() {}",
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ i18nLocaleDir: "[locale]" }));

  expect(findAction(plan.actions, "app/[locale]/sign-in/[[...sign-in]]/page.tsx")).toMatchObject({
    type: "skip",
    skipReason: "Sign-in page already exists",
  });
});

test("creates composed Clerk + next-intl middleware when next-intl is a dep", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ deps: { "next-intl": "4.0.0" } }));
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("create");
  if (mw.type !== "create") throw new Error("Expected create action");
  expect(mw.content).toContain("next-intl/middleware");
  expect(mw.content).toContain("clerkMiddleware");
  expect(mw.content).toContain("intlMiddleware(request)");
  // i18n middleware should include locale-prefixed public routes
  expect(mw.content).toContain("/:locale/sign-in(.*)");
  expect(mw.content).toContain("/:locale/sign-up(.*)");
});

test("imports routing config in composed middleware when next-intl routing file exists", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await mkdir(join(tempDir, "i18n"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "i18n/routing.ts"), "export const routing = {};");

  const plan = await nextjsApp.scaffold(makeCtx({ deps: { "next-intl": "4.0.0" } }));
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("create");
  if (mw.type !== "create") throw new Error("Expected create action");
  expect(mw.content).toContain('import { routing } from "./i18n/routing"');
  expect(mw.content).toContain("createMiddleware(routing)");
});

test("composes Clerk with existing next-intl expression middleware", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next).*)"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("modify");
  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain("@clerk/nextjs/server");
  expect(mw.content).toContain("const intlMiddleware = createMiddleware(routing)");
  expect(mw.content).toContain("intlMiddleware(request)");
  expect(mw.content).toContain("clerkMiddleware");
  // Should NOT have the old config
  expect(mw.content).not.toContain('matcher: ["/((?!api|_next).*)"]');
});

test("composes Clerk with existing i18n middleware that has a function export", async () => {
  // This is the thayto.com pattern: user already composed their own middleware function
  // that creates intlMiddleware internally and has a custom default export function.
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { NextRequest, NextResponse } from "next/server";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const locale = detectLocale(request);
  return intlMiddleware(request);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|socket\\.io|.*\\..*).*)'],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("modify");
  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain("@clerk/nextjs/server");
  expect(mw.content).toContain("clerkMiddleware");
  // Should rename the function to middleware, NOT create a duplicate intlMiddleware
  expect(mw.content).toContain("async function middleware");
  expect(mw.content).toContain("middleware(request)");
  // Should NOT have duplicate variable names
  expect(mw.content.match(/const intlMiddleware/g)?.length).toBe(1);
  // Should include locale-prefixed public routes for i18n
  expect(mw.content).toContain("/:locale/sign-in(.*)");
  expect(mw.content).toContain("/:locale/sign-up(.*)");
  // Should strip the old config and use Clerk's
  expect(mw.content).not.toContain("socket\\.io");
});

test("falls back to general composer when i18n middleware already defines the varName", async () => {
  // Edge case: export default is an expression but the varName is already taken
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import createMiddleware from "next-intl/middleware";

const intlMiddleware = createMiddleware({ locales: ["en"], defaultLocale: "en" });
const wrapped = (req) => intlMiddleware(req);

export default wrapped;
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("modify");
  if (mw.type !== "modify") throw new Error("Expected modify action");
  // Should NOT create duplicate intlMiddleware; general composer renames export to `const middleware`
  expect(mw.content.match(/const intlMiddleware/g)?.length).toBe(1);
  expect(mw.content).toContain("const middleware = wrapped");
  expect(mw.content).toContain("middleware(request)");
});
