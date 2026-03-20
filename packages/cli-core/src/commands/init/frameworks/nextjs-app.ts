import { join } from "node:path";
import {
  jsxAuthPageContent,
  jsxExt,
  NEXTJS_SIGN_ROUTES_INSTRUCTION,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldNextjsMiddleware,
  srcPrefix,
  wrapBodyWithProvider,
} from "./helpers.js";
import { enrichNextjsContext } from "./nextjs-context.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

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

  return {
    path: ctx.layoutPath,
    type: "modify",
    content: newContent,
    description: hasBody
      ? "Add ClerkProvider import and wrap body contents"
      : "Add ClerkProvider import (manual wrapping needed)",
  };
}

function authPagePath(ctx: ProjectContext, kind: "sign-in" | "sign-up"): string {
  return `${srcPrefix(ctx)}app/${kind}/[[...${kind}]]/page.${jsxExt(ctx)}`;
}

async function scaffoldAuthPages(ctx: ProjectContext): Promise<FileAction[]> {
  return scaffoldAuthFiles(ctx.cwd, [
    {
      path: authPagePath(ctx, "sign-in"),
      content: jsxAuthPageContent("sign-in", "@clerk/nextjs"),
      kind: "sign-in",
      surface: "page",
    },
    {
      path: authPagePath(ctx, "sign-up"),
      content: jsxAuthPageContent("sign-up", "@clerk/nextjs"),
      kind: "sign-up",
      surface: "page",
    },
  ]);
}

export const nextjsApp: FrameworkScaffold = {
  name: "Next.js (App Router)",
  dep: "next",
  variant: "app-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant !== "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [middlewareAction, layoutAction, authActions] = await Promise.all([
      scaffoldNextjsMiddleware(ctx),
      scaffoldLayout(ctx),
      scaffoldAuthPages(ctx),
    ]);

    return {
      actions: [middlewareAction, layoutAction, ...authActions],
      postInstructions: [NEXTJS_SIGN_ROUTES_INSTRUCTION],
    };
  },
};
