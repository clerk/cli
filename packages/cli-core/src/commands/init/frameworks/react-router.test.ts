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
    },
    typescript: true,
    srcDir: false,
    packageManager: "npm",
    existingClerk: false,
    deps: { "react-router": "7.0.0" },
    envFile: ".env",
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
