import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gatherContext } from "./context.ts";
import { enrichProjectContext, scaffold } from "./scaffold.ts";
import { parseMajorVersion } from "./frameworks/helpers.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-ctx-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("returns null when no package.json exists", async () => {
  const ctx = await gatherContext(tempDir);
  expect(ctx).toBeNull();
});

test("returns null when no framework detected", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { lodash: "4.0.0" } }),
  );
  const ctx = await gatherContext(tempDir);
  expect(ctx).toBeNull();
});

test("detects Next.js with app-router variant", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx).not.toBeNull();
  expect(ctx!.framework.dep).toBe("next");
  expect(ctx!.framework.sdk).toBe("@clerk/nextjs");
  expect(ctx!.variant).toBe("app-router");
  expect(ctx!.typescript).toBe(true);
  expect(ctx!.srcDir).toBe(false);
  expect(ctx!.layoutPath).toBe("app/layout.tsx");
  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("detects Next.js with pages-router variant", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "12.0.0", react: "18.0.0" } }),
  );
  await mkdir(join(tempDir, "pages"), { recursive: true });
  await Bun.write(join(tempDir, "pages/_app.tsx"), "export default function App() {}");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx).not.toBeNull();
  expect(ctx!.variant).toBe("pages-router");
  expect(ctx!.layoutPath).toBe("pages/_app.tsx");
});

test("detects src/ directory convention", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "src/app"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx).not.toBeNull();
  expect(ctx!.srcDir).toBe(true);
  expect(ctx!.layoutPath).toBe("src/app/layout.tsx");
});

test("detects JavaScript projects (no tsconfig)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.jsx"), "<html><body>{children}</body></html>");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx).not.toBeNull();
  expect(ctx!.typescript).toBe(false);
  expect(ctx!.layoutPath).toBe("app/layout.jsx");
});

test("detects existing Clerk SDK in dependencies", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", "@clerk/nextjs": "6.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);

  expect(ctx).not.toBeNull();
  expect(ctx!.existingClerk).toBe(true);
});

test("detects package manager from bun.lockb", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "bun.lockb"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);

  expect(ctx!.packageManager).toBe("bun");
});

test("detects package manager from bun.lock (text format)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "bun.lock"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);

  expect(ctx!.packageManager).toBe("bun");
});

test("detects package manager from yarn.lock", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "yarn.lock"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);

  expect(ctx!.packageManager).toBe("yarn");
});

test("defaults to npm when no lockfile found", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);

  expect(ctx!.packageManager).toBe("npm");
});

test("defaults to app-router when neither app/ nor pages/ exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.variant).toBe("app-router");
  expect(ctx!.layoutPath).toBeNull();
});

test("uses proxy.ts for Next.js 16+", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("proxy");
});

test("uses middleware.ts for Next.js 15", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.1.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("uses middleware.ts for Next.js with caret range ≤15", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "^14.2.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("uses proxy.ts for Next.js with caret range ≥16", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "^16.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("proxy");
});

test("prefers existing proxy.ts over version detection", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");
  await Bun.write(join(tempDir, "proxy.ts"), "export default function() {}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  // Even though version is 15 (would normally pick middleware), proxy.ts exists
  expect(ctx!.middlewareBasename).toBe("proxy");
});

test("prefers existing middleware.ts over version detection", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");
  await Bun.write(join(tempDir, "middleware.ts"), "export default function() {}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  // Even though version is 16 (would normally pick proxy), middleware.ts exists
  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("parseMajorVersion handles various formats", () => {
  expect(parseMajorVersion("15.0.0")).toBe(15);
  expect(parseMajorVersion("^16.1.0")).toBe(16);
  expect(parseMajorVersion("~14.2.3")).toBe(14);
  expect(parseMajorVersion(">=16")).toBe(16);
  expect(parseMajorVersion("latest")).toBeNull();
  expect(parseMajorVersion("*")).toBeNull();
  expect(parseMajorVersion("canary")).toBeNull();
});

test("scaffold skips when framework version is below minimum", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "12.0.0", react: "18.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  const plan = await scaffold(ctx!);

  expect(plan.actions).toHaveLength(0);
  expect(plan.postInstructions[0]).toContain("below the minimum supported version");
});

test("scaffold proceeds when framework version meets minimum", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  const plan = await scaffold(ctx!);

  expect(plan.actions.length).toBeGreaterThan(0);
});

test("scaffold proceeds for Next.js 16 and uses proxy.ts", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gatherContext(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("proxy");

  const plan = await scaffold(ctx!);

  expect(plan.actions.length).toBeGreaterThan(0);
  expect(plan.actions[0]!.path).toBe("proxy.ts");
});
