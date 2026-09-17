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
      envFile: ".env" as const,
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
    // Bare middleware — route protection moved to individual resources
    // (createRouteMatcher in middleware is deprecated)
    expect(mw.content).toContain("export default clerkMiddleware()");
    expect(mw.content).not.toContain("createRouteMatcher");
    expect(mw.content).not.toContain("auth.protect");
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
  expect(plan.postInstructions).toHaveLength(1);
  expect(plan.postInstructions[0]).toContain("auth.protect()");
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
  expect(mw.content.match(/export default clerkMiddleware/g)?.length).toBe(1);
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
  // No middleware-level route protection (createRouteMatcher is deprecated)
  expect(mw.content).not.toContain("createRouteMatcher");
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
  // No middleware-level route protection (createRouteMatcher is deprecated)
  expect(mw.content).not.toContain("createRouteMatcher");
  // Should strip the old config and use Clerk's
  expect(mw.content).not.toContain("socket\\.io");
});

// The generated matcher must route Clerk's frontend API proxy paths (`/__clerk/*`)
// through clerkMiddleware. The first matcher entry excludes anything that looks like
// a static file, so proxy paths such as `/__clerk/v1/client.json` need this entry.
const CLERK_PROXY_MATCHER = '"/__clerk/(.*)"';

test("generated middleware matches Clerk frontend API proxy routes", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "create") throw new Error("Expected create action");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
});

test("proxy.ts for Next.js 16+ matches Clerk frontend API proxy routes", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ middlewareBasename: "proxy" }));
  const mw = findAction(plan.actions, "proxy.ts");

  if (mw.type !== "create") throw new Error("Expected create action");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
});

test("i18n-composed middleware matches Clerk frontend API proxy routes", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx({ deps: { "next-intl": "4.0.0" } }));
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "create") throw new Error("Expected create action");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
});

test("replacing an existing matcher keeps the Clerk frontend API proxy routes", async () => {
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

  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).not.toContain('matcher: ["/((?!api|_next).*)"]');
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
});

test("composes into existing middleware that declares its own matcher", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { NextResponse } from "next/server";

export default function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  // Previously skipped outright, leaving the project with no Clerk middleware at all
  expect(mw.type).toBe("modify");
  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain("clerkMiddleware");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
  // The user's own handler is preserved, only their matcher is replaced
  expect(mw.content).toContain("NextResponse.next()");
  expect(mw.content).not.toContain('"/dashboard/:path*"');
  expect(mw.description).toContain("replacing");
});

// The config strip is regex surgery: shapes it can't cut cleanly (a call
// expression spanning lines, a literal followed by `satisfies`) must degrade
// to a skip rather than a silent write of a middleware file that no longer
// parses.
test("skips when the config export's value is a call expression", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `async function middleware(req) { return; }

export const config = buildConfig({
  matcher: ["/foo"],
});

export default middleware;
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("skip");
});

test("skips when the config export uses a satisfies clause", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `export default async function middleware(req) {}

export const config = { matcher: ["/x"] } satisfies MiddlewareConfig;
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  expect(mw.type).toBe("skip");
});

test("strips a config export containing a closing brace inside a comment", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { NextResponse } from "next/server";

export default function middleware() {
  return NextResponse.next();
}

export const config = {
  // closing } brace in comment
  matcher: ["/x"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
  expect(mw.content).not.toContain("brace in comment");
  // The composed file must parse — the strip must not orphan config remnants
  new Bun.Transpiler({ loader: "tsx" }).transformSync(mw.content);
});

test("preserves user logic when the config export precedes the default export", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import { NextResponse } from "next/server";

export const config = {
  matcher: ["/dashboard/:path*"],
};

export default function middleware(req) {
  if (req.nextUrl.pathname === "/blocked") return new NextResponse("BLOCKED", { status: 403 });
  return NextResponse.next();
}
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "modify") throw new Error("Expected modify action");
  // Stripping the config must not swallow everything after it
  expect(mw.content).toContain("BLOCKED");
  expect(mw.content).toContain("middleware(request)");
  expect(mw.content).not.toContain('"/dashboard/:path*"');
  expect(mw.content.match(/export const config/g)?.length).toBe(1);
});

test("strips a config export that carries a type annotation", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `import type { MiddlewareConfig } from "next/server";

export default function middleware() {
  return "USER_LOGIC";
}

export const config: MiddlewareConfig = {
  matcher: ["/dashboard/:path*"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain("USER_LOGIC");
  expect(mw.content).not.toContain('"/dashboard/:path*"');
  expect(mw.content.match(/export const config/g)?.length).toBe(1);
});

const UNSUPPORTED_SHAPES = [
  [
    "re-exported default",
    `export { default } from "./custom-middleware";

export const config = {
  matcher: ["/api/:path*"],
};
`,
  ],
  [
    "renamed re-exported default",
    `export { handler as default } from "./custom-middleware";

export const config = {
  matcher: ["/api/:path*"],
};
`,
  ],
  [
    "class default export",
    `export default class ApiGuard {
  async handle(request: Request) {
    return new Response("ok");
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
`,
  ],
];

// Composing these would emit a module with two default exports, or wrap something
// that isn't callable. Leaving the file untouched beats writing code that can't run.
test.each(UNSUPPORTED_SHAPES)("skips composition for %s", async (_name, middleware) => {
  await Bun.write(join(tempDir, "middleware.ts"), middleware as string);
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());

  expect(findAction(plan.actions, "middleware.ts")).toMatchObject({
    type: "skip",
    skipReason: "Existing middleware uses an unsupported shape for automatic Clerk composition",
  });
});

test("still composes when `default` only appears as a re-export source name", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `export { default as logger } from "./logger";

export default function middleware() {
  return "USER_LOGIC";
}

export const config = {
  matcher: ["/api/:path*"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content).toContain("USER_LOGIC");
  expect(mw.content).toContain(CLERK_PROXY_MATCHER);
});

test("does not duplicate the config export when replacing an existing matcher", async () => {
  await Bun.write(
    join(tempDir, "middleware.ts"),
    `export default function middleware() {}

export const config = {
  matcher: ["/dashboard/:path*"],
};
`,
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "modify") throw new Error("Expected modify action");
  expect(mw.content.match(/export const config/g)?.length).toBe(1);
  expect(mw.content.match(/export default clerkMiddleware/g)?.length).toBe(1);
});

test("generated matcher escapes the static-file pattern for the emitted file", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");

  const plan = await nextjsApp.scaffold(makeCtx());
  const mw = findAction(plan.actions, "middleware.ts");

  if (mw.type !== "create") throw new Error("Expected create action");
  // The emitted file carries `\\.` inside a string literal so the matcher Next.js
  // compiles sees a literal `\.` — losing one level here would break the regex.
  expect(mw.content).toContain(String.raw`[^?]*\\.(?:html?|css|js(?!on)`);
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

test("adds auth header in layout during bootstrap with Tailwind", async () => {
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

  const plan = await nextjsApp.scaffold(
    makeCtx({ isBootstrap: true, deps: { tailwindcss: "4.0.0" } }),
  );
  const layout = findAction(plan.actions, "app/layout.tsx");

  expect(layout.type).toBe("modify");
  if (layout.type !== "modify") throw new Error("Expected modify action");

  // Auth header components are present
  expect(layout.content).toContain('<Show when="signed-out">');
  expect(layout.content).toContain("<SignInButton />");
  expect(layout.content).toContain("<SignUpButton />");
  expect(layout.content).toContain('<Show when="signed-in">');
  expect(layout.content).toContain("<UserButton />");

  // Tailwind classes on header
  expect(layout.content).toContain(
    'className="flex h-16 items-center justify-end gap-4 border-b px-4"',
  );

  // All imports merged into a single @clerk/nextjs import
  expect(layout.content).toContain("ClerkProvider");
  expect(layout.content).toContain("Show");
  expect(layout.content).toContain("SignInButton");
  expect(layout.content).toContain("SignUpButton");
  expect(layout.content).toContain("UserButton");

  // Description mentions auth header
  expect(layout.description).toContain("auth header");
});

test("does not add auth header for non-bootstrap init", async () => {
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
  const layout = findAction(plan.actions, "app/layout.tsx");

  expect(layout.type).toBe("modify");
  if (layout.type !== "modify") throw new Error("Expected modify action");

  // Should have ClerkProvider but NOT the auth header
  expect(layout.content).toContain("ClerkProvider");
  expect(layout.content).not.toContain("<Show");
  expect(layout.content).not.toContain("<SignInButton");
  expect(layout.content).not.toContain("<UserButton");
});

test("uses plain styles for auth header when no Tailwind", async () => {
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

  const plan = await nextjsApp.scaffold(makeCtx({ isBootstrap: true, deps: {} }));
  const layout = findAction(plan.actions, "app/layout.tsx");

  expect(layout.type).toBe("modify");
  if (layout.type !== "modify") throw new Error("Expected modify action");

  // Plain styles instead of Tailwind
  expect(layout.content).toContain("style={{");
  expect(layout.content).toContain("justifyContent");
  expect(layout.content).toContain("borderBottom");
  expect(layout.content).not.toContain('className="flex');
});
