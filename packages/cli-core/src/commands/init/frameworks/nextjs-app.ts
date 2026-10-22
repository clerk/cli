import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addSuspenseImport,
  authFileSpecs,
  findFirstFile,
  hasTailwindStyles,
  injectHeaderInProvider,
  jsxAuthPageContent,
  jsxExt,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldEnvVars,
  scaffoldNextjsMiddleware,
  SIGN_ROUTE_ENV_VARS,
  srcPrefix,
  type AuthKind,
  wrapBodyWithProvider,
} from "./helpers.js";
import { enrichNextjsContext } from "./nextjs-context.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

// Place the Suspense import after the Clerk and Next.js imports, before local and CSS imports.
function precedesSuspenseImport(specifier: string): boolean {
  return specifier === "@clerk/nextjs" || specifier === "next" || specifier.startsWith("next/");
}

async function scaffoldLayout(ctx: ProjectContext): Promise<FileAction> {
  const base = srcPrefix(ctx);
  const jsx = jsxExt(ctx);
  const expectedPath = ctx.layoutPath ?? `${base}app/layout.${jsx}`;

  if (!ctx.layoutPath) {
    return { type: "skip", path: expectedPath, skipReason: "Layout file not found" };
  }

  const fullPath = join(ctx.cwd, ctx.layoutPath);
  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    return { type: "skip", path: ctx.layoutPath, skipReason: "Layout file not found" };
  }

  const content = await file.text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path: ctx.layoutPath, skipReason: "Already has ClerkProvider" };
  }

  let newContent = safeAddImport(content, "@clerk/nextjs", "ClerkProvider");

  // TODO: Consider using AST (e.g. ts-morph) for JSX manipulation to enforce
  // modifying the default export. Magicast does not support JSX/TSX.
  const hasBody = newContent.includes("<body");

  if (hasBody) {
    newContent = wrapBodyWithProvider(newContent, "ClerkProvider");
  }

  if (ctx.isBootstrap && hasBody) {
    newContent = safeAddImport(newContent, "@clerk/nextjs", "Show");
    newContent = safeAddImport(newContent, "@clerk/nextjs", "SignInButton");
    newContent = safeAddImport(newContent, "@clerk/nextjs", "SignUpButton");
    newContent = safeAddImport(newContent, "@clerk/nextjs", "UserButton");
    newContent = addSuspenseImport(newContent, precedesSuspenseImport);
    newContent = injectHeaderInProvider(newContent, hasTailwindStyles(ctx), { suspense: true });
  }

  return {
    path: ctx.layoutPath,
    type: "modify",
    content: newContent,
    description: hasBody
      ? ctx.isBootstrap
        ? "Add ClerkProvider, wrap body contents, and add auth header"
        : "Add ClerkProvider import and wrap body contents"
      : "Add ClerkProvider import (manual wrapping needed)",
  };
}

function authPagePath(ctx: ProjectContext, kind: AuthKind): string {
  const localeSegment = ctx.i18nLocaleDir ? `${ctx.i18nLocaleDir}/` : "";
  return `${srcPrefix(ctx)}app/${localeSegment}${kind}/[[...${kind}]]/page.${jsxExt(ctx)}`;
}

const PAGE_EXTENSIONS = ["tsx", "jsx", "ts", "js"] as const;

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/**
 * Find an existing catch-all auth page that serves the same URL as `authPagePath`.
 * Route groups like `(marketing)` don't change the URL, so they may appear at any depth,
 * before or after the i18n locale segment.
 */
async function findExistingAuthPage(ctx: ProjectContext, kind: AuthKind): Promise<string | null> {
  const pending = [{ dir: `${srcPrefix(ctx)}app`, needsLocale: Boolean(ctx.i18nLocaleDir) }];

  while (pending.length > 0) {
    const { dir, needsLocale } = pending.shift()!;

    if (!needsLocale) {
      const pageDir = `${dir}/${kind}/[[...${kind}]]`;
      const page = await findFirstFile(
        ctx.cwd,
        PAGE_EXTENSIONS.map((ext) => `${pageDir}/page.${ext}`),
      );
      if (page) return page;
    }

    let entries;
    try {
      entries = await readdir(join(ctx.cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (isRouteGroup(entry.name)) {
        pending.push({ dir: `${dir}/${entry.name}`, needsLocale });
      } else if (needsLocale && entry.name === ctx.i18nLocaleDir) {
        pending.push({ dir: `${dir}/${entry.name}`, needsLocale: false });
      }
    }
  }

  return null;
}

async function scaffoldAuthPages(ctx: ProjectContext): Promise<FileAction[]> {
  const tailwind = hasTailwindStyles(ctx);
  return scaffoldAuthFiles(
    ctx.cwd,
    authFileSpecs({
      path: (kind) => authPagePath(ctx, kind),
      content: (kind) => jsxAuthPageContent(kind, "@clerk/nextjs", tailwind, { suspense: true }),
      surface: "page",
    }),
    { findExisting: async (kind) => findExistingAuthPage(ctx, kind) },
  );
}

export const nextjsApp: FrameworkScaffold = {
  name: "Next.js (App Router)",
  dep: "next",
  variant: "app-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant !== "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [middlewareAction, layoutAction, authActions, envAction] = await Promise.all([
      scaffoldNextjsMiddleware(ctx),
      scaffoldLayout(ctx),
      scaffoldAuthPages(ctx),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.nextjs),
    ]);

    return {
      actions: [middlewareAction, layoutAction, ...authActions, envAction],
      postInstructions: [
        "Routes are public by default — protect pages, Route Handlers, and Server Actions individually with `await auth.protect()`. See: https://clerk.com/docs/reference/nextjs/auth",
      ],
    };
  },
};
