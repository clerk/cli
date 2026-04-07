import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gather } from "./index.ts";
import { enrichProjectContext, scaffold } from "../../commands/init/scaffold.ts";
import { parseMajorVersion } from "../../commands/init/frameworks/helpers.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "clerk-ctx-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("returns null when no package.json exists", async () => {
  const ctx = await gather(tempDir);
  expect(ctx).toBeNull();
});

test("returns null when no framework detected", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { lodash: "4.0.0" } }),
  );
  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx).not.toBeNull();
  expect(ctx!.srcDir).toBe(true);
  expect(ctx!.layoutPath).toBe("src/app/layout.tsx");
});

test("sets srcDir true for bare src/ directory (no src/app or src/pages)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", vite: "6.0.0" } }),
  );
  await mkdir(join(tempDir, "src"), { recursive: true });

  const ctx = await gather(tempDir);

  expect(ctx).not.toBeNull();
  expect(ctx!.srcDir).toBe(true);
});

test("detects JavaScript projects (no tsconfig)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.jsx"), "<html><body>{children}</body></html>");

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);

  expect(ctx).not.toBeNull();
  expect(ctx!.existingClerk).toBe(true);
});

test("existingClerk is false when a different @clerk package is installed", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { nuxt: "3.12.0", "@clerk/themes": "2.0.0" } }),
  );

  const ctx = await gather(tempDir);

  expect(ctx).not.toBeNull();
  expect(ctx!.framework.sdk).toBe("@clerk/nuxt");
  expect(ctx!.existingClerk).toBe(false);
});

test("detects package manager from bun.lockb", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "bun.lockb"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);

  expect(ctx!.packageManager).toBe("bun");
});

test("detects package manager from bun.lock (text format)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "bun.lock"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);

  expect(ctx!.packageManager).toBe("bun");
});

test("detects package manager from yarn.lock", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, "yarn.lock"), "");
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);

  expect(ctx!.packageManager).toBe("yarn");
});

test("defaults to npm when no lockfile found", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);

  expect(ctx!.packageManager).toBe("npm");
});

// ─── envFile detection ────────────────────────────────────────────────────────

test("Next.js: uses .env when only .env exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env"), "EXISTING=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env");
});

test("Next.js: uses .env when neither .env nor .env.local exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env");
});

test("Next.js: uses .env.local when both .env and .env.local exist (keep existing setup)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env"), "EXISTING=1");
  await Bun.write(join(tempDir, ".env.local"), "LOCAL=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.local");
});

test("Next.js: falls back to .env.local when only .env.local exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env.local"), "LOCAL=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.local");
});

test("React (Vite): uses .env.local when only .env.local exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", vite: "6.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env.local"), "LOCAL=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.local");
});

test("React (Vite): uses .env.local when neither .env nor .env.local exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", vite: "6.0.0" } }),
  );

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.local");
});

test("React (Vite): falls back to existing .env when only .env exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", vite: "6.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env"), "EXISTING=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env");
});

test("uses .env.development.local when it exists (highest priority)", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env"), "EXISTING=1");
  await Bun.write(join(tempDir, ".env.development.local"), "DEV_LOCAL=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.development.local");
});

test(".env.development.local beats .env.local", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env.local"), "LOCAL=1");
  await Bun.write(join(tempDir, ".env.development.local"), "DEV_LOCAL=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.development.local");
});

test("uses .env.development when it exists and no higher-priority file present", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );
  await Bun.write(join(tempDir, ".env.development"), "DEV=1");

  const ctx = await gather(tempDir);

  expect(ctx!.envFile).toBe(".env.development");
});

test("defaults to app-router when neither app/ nor pages/ exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0" } }),
  );

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("proxy");
});

test("uses middleware.ts for Next.js 15", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.1.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("uses middleware.ts for Next.js with caret range <=15", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "^14.2.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("uses proxy.ts for Next.js with caret range >=16", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "^16.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  // Even though version is 16 (would normally pick proxy), middleware.ts exists
  expect(ctx!.middlewareBasename).toBe("middleware");
});

test("detects [locale] directory for i18n in App Router", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }),
  );
  await mkdir(join(tempDir, "app/[locale]"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "app/[locale]/layout.tsx"), "<NextIntlClientProvider>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.variant).toBe("app-router");
  expect(ctx!.i18nLocaleDir).toBe("[locale]");
});

test("detects [lang] directory for i18n in App Router", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app/[lang]"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "app/[lang]/layout.tsx"), "export default function() {}");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.i18nLocaleDir).toBe("[lang]");
});

test("does not set i18nLocaleDir when no locale directory exists", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.i18nLocaleDir).toBeUndefined();
});

test("does not set i18nLocaleDir for [locale] without layout", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "app/[locale]"), { recursive: true });
  await Bun.write(join(tempDir, "app/layout.tsx"), "<html><body>{children}</body></html>");
  // No layout inside [locale], could be a non-i18n dynamic route
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.i18nLocaleDir).toBeUndefined();
});

test("detects i18n locale dir with src/ convention", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "src/app/[locale]"), { recursive: true });
  await Bun.write(join(tempDir, "src/app/layout.tsx"), "<html><body>{children}</body></html>");
  await Bun.write(join(tempDir, "src/app/[locale]/layout.tsx"), "<NextIntlClientProvider>");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.srcDir).toBe(true);
  expect(ctx!.i18nLocaleDir).toBe("[locale]");
});

test("does not set i18nLocaleDir for Pages Router", async () => {
  await Bun.write(
    join(tempDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  );
  await mkdir(join(tempDir, "pages"), { recursive: true });
  await Bun.write(join(tempDir, "pages/_app.tsx"), "export default function App() {}");
  await Bun.write(join(tempDir, "tsconfig.json"), "{}");

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.variant).toBe("pages-router");
  expect(ctx!.i18nLocaleDir).toBeUndefined();
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

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
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

  const ctx = await gather(tempDir);
  await enrichProjectContext(ctx!);

  expect(ctx!.middlewareBasename).toBe("proxy");

  const plan = await scaffold(ctx!);

  expect(plan.actions.length).toBeGreaterThan(0);
  expect(plan.actions.find((a) => a.path === "proxy.ts")).toBeDefined();
});
