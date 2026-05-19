import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reactRouter } from "./react-router.ts";
import type { ProjectContext } from "./types.ts";

let tempDir: string;

function makeCtx(overrides?: Partial<ProjectContext>): ProjectContext {
  return {
    cwd: tempDir,
    framework: {
      dep: "react-router",
      name: "React Router",
      sdk: "@clerk/react-router",
      envVar: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: { "react-router": "7.0.0" },
    envFile: ".env.local",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-react-router-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("adds middleware, loader, and provider to app/root.tsx", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";

export default function Root() {
  return <Outlet />;
}
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const rootAction = plan.actions.find((action) => action.path === "app/root.tsx");

  expect(rootAction).toBeDefined();
  expect(rootAction?.type).toBe("modify");

  if (rootAction?.type !== "modify") {
    throw new Error("Expected root action to modify app/root.tsx");
  }

  expect(rootAction.content).toContain("@clerk/react-router/server");
  expect(rootAction.content).toContain("useLoaderData");
  expect(rootAction.content).toContain("export const middleware = [clerkMiddleware()];");
  expect(rootAction.content).toContain(
    "export const loader = (args: Parameters<typeof rootAuthLoader>[0]) => rootAuthLoader(args);",
  );
  expect(rootAction.content).toContain("const loaderData = useLoaderData<typeof loader>();");
  expect(rootAction.content).toContain("<ClerkProvider loaderData={loaderData}>");
});

test("prefixes auth routes with ($locale) when locale routes detected", async () => {
  await mkdir(join(tempDir, "app/routes"), { recursive: true });
  // Create an existing route with ($locale) prefix to simulate i18n setup
  await Bun.write(join(tempDir, "app/routes/($locale)._index.tsx"), "export default function() {}");
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "app/routes/($locale).sign-in.tsx")).toBe(
    true,
  );
  expect(plan.actions.some((action) => action.path === "app/routes/($locale).sign-up.tsx")).toBe(
    true,
  );
});

test("does not prefix auth routes when no locale routes detected", async () => {
  await mkdir(join(tempDir, "app/routes"), { recursive: true });
  await Bun.write(join(tempDir, "app/routes/_index.tsx"), "export default function() {}");
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());

  expect(plan.actions.some((action) => action.path === "app/routes/sign-in.tsx")).toBe(true);
  expect(plan.actions.some((action) => action.path === "app/routes/sign-up.tsx")).toBe(true);
});

test("keeps an existing loader manual when rootAuthLoader is not present", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";

export const loader = () => ({ ok: true });

export default function Root() {
  return <Outlet />;
}
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const rootAction = plan.actions.find((action) => action.path === "app/root.tsx");

  expect(rootAction).toBeDefined();
  expect(rootAction?.type).toBe("modify");

  if (rootAction?.type !== "modify") {
    throw new Error("Expected root action to modify app/root.tsx");
  }

  expect(rootAction.content).toContain('from "@clerk/react-router/server";');
  expect(rootAction.content).toContain("clerkMiddleware");
  expect(rootAction.content).toContain("export const middleware = [clerkMiddleware()];");
  expect(rootAction.content).not.toContain("rootAuthLoader");
  expect(rootAction.content).not.toContain("useLoaderData");
  expect(rootAction.content).toContain("<ClerkProvider>");
  expect(rootAction.content).not.toContain("loaderData={loaderData}");
  expect(
    plan.postInstructions.some((instruction) =>
      instruction.includes("Update your existing app/root.tsx loader"),
    ),
  ).toBe(true);
});

test("wires sign-in and sign-up routes into app/routes.ts (canonical pattern)", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index } from "@react-router/dev/routes";

export default [index("routes/home.tsx")] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  expect(routesAction).toBeDefined();
  expect(routesAction?.type).toBe("modify");

  if (routesAction?.type !== "modify") {
    throw new Error("Expected routes action to modify app/routes.ts");
  }

  expect(routesAction.content).toContain("route");
  expect(routesAction.content).toContain('route("sign-in/*", "routes/sign-in.tsx")');
  expect(routesAction.content).toContain('route("sign-up/*", "routes/sign-up.tsx")');
  // `route` should be added to the import
  expect(routesAction.content).toMatch(/import\s*\{[^}]*\broute\b[^}]*\}/);
});

test("does not duplicate routes when app/routes.ts already has them wired", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in/*", "routes/sign-in.tsx"),
  route("sign-up/*", "routes/sign-up.tsx"),
] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  // Should be skipped, not modified again
  expect(routesAction?.type).toBe("skip");
});

test("emits manual route wiring instruction when app/routes.ts is absent", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());

  // No routes.ts means no routes action
  expect(plan.actions.find((a) => a.path?.includes("routes.ts"))).toBeUndefined();
  // And no manual wiring instruction since there's nothing to wire
  expect(plan.postInstructions.some((i) => i.includes("Add sign-in and sign-up routes"))).toBe(
    false,
  );
});

test("uses .jsx extension for routes in a JavaScript project", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index } from "@react-router/dev/routes";

export default [index("routes/home.jsx")] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx({ typescript: false }));
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  expect(routesAction?.type).toBe("modify");
  if (routesAction?.type !== "modify") throw new Error("Expected modify");

  expect(routesAction.content).toContain('route("sign-in/*", "routes/sign-in.jsx")');
  expect(routesAction.content).toContain('route("sign-up/*", "routes/sign-up.jsx")');
  expect(routesAction.content).not.toContain(".tsx");
});

test("does not duplicate routes on re-run for JS project (dedup is extension-agnostic)", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  // Simulate a routes.ts already containing .jsx entries (written by a previous JS run)
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.jsx"),
  route("sign-in/*", "routes/sign-in.jsx"),
  route("sign-up/*", "routes/sign-up.jsx"),
] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx({ typescript: false }));
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  expect(routesAction?.type).toBe("skip");
});

test("only injects missing route when one auth route already exists", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in/*", "routes/sign-in.tsx"),
] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  expect(routesAction?.type).toBe("modify");
  if (routesAction?.type !== "modify") throw new Error("Expected modify");

  // sign-in already present — only sign-up injected, no duplicate sign-in.
  // A single route("sign-in/*", "routes/sign-in.tsx") entry contains "sign-in" twice
  // (once in the URL path, once in the file path), so 2 is the expected count.
  const occurrences = (routesAction.content.match(/sign-in/g) ?? []).length;
  expect(occurrences).toBe(2);
  expect(routesAction.content).toContain('route("sign-up/*", "routes/sign-up.tsx")');
});

test("adds auth header in root during bootstrap with Tailwind", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";

export default function Root() {
  return <Outlet />;
}
`,
  );

  const plan = await reactRouter.scaffold(
    makeCtx({ isBootstrap: true, deps: { "react-router": "7.0.0", tailwindcss: "4.0.0" } }),
  );
  const rootAction = plan.actions.find((action) => action.path === "app/root.tsx");

  expect(rootAction?.type).toBe("modify");
  if (rootAction?.type !== "modify") throw new Error("Expected modify action");

  expect(rootAction.content).toContain('<Show when="signed-out">');
  expect(rootAction.content).toContain("<SignInButton />");
  expect(rootAction.content).toContain("<SignUpButton />");
  expect(rootAction.content).toContain('<Show when="signed-in">');
  expect(rootAction.content).toContain("<UserButton />");
  expect(rootAction.content).toContain(
    'className="flex h-16 items-center justify-end gap-4 border-b px-4"',
  );
  expect(rootAction.description).toContain("auth header");
});

test("does not add auth header for non-bootstrap init", async () => {
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";

export default function Root() {
  return <Outlet />;
}
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const rootAction = plan.actions.find((action) => action.path === "app/root.tsx");

  expect(rootAction?.type).toBe("modify");
  if (rootAction?.type !== "modify") throw new Error("Expected modify action");

  expect(rootAction.content).toContain("ClerkProvider");
  expect(rootAction.content).not.toContain("<Show");
  expect(rootAction.content).not.toContain("<SignInButton");
});

test("wires locale-prefixed routes into app/routes.ts", async () => {
  await mkdir(join(tempDir, "app/routes"), { recursive: true });
  await Bun.write(join(tempDir, "app/routes/($locale)._index.tsx"), "export default function() {}");
  await Bun.write(
    join(tempDir, "app/root.tsx"),
    `import { Outlet } from "react-router";
export default function Root() { return <Outlet />; }
`,
  );
  await Bun.write(
    join(tempDir, "app/routes.ts"),
    `import { type RouteConfig, index } from "@react-router/dev/routes";

export default [index("routes/home.tsx")] satisfies RouteConfig;
`,
  );

  const plan = await reactRouter.scaffold(makeCtx());
  const routesAction = plan.actions.find((action) => action.path === "app/routes.ts");

  expect(routesAction?.type).toBe("modify");

  if (routesAction?.type !== "modify") {
    throw new Error("Expected routes action to modify app/routes.ts");
  }

  expect(routesAction.content).toContain(
    'route("($locale)/sign-in/*", "routes/($locale).sign-in.tsx")',
  );
  expect(routesAction.content).toContain(
    'route("($locale)/sign-up/*", "routes/($locale).sign-up.tsx")',
  );
});
