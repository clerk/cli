import { join } from "node:path";
import {
  NEXTJS_SIGN_ROUTES_INSTRUCTION,
  nextjsSignInPageContent,
  nextjsSignUpPageContent,
  safeAddImport,
  scaffoldAuthPage,
  scaffoldNextjsMiddleware,
  wrapBodyWithProvider,
} from "./helpers.js";
import { enrichNextjsContext } from "./nextjs-context.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function scaffoldLayout(ctx: ProjectContext): Promise<FileAction> {
  const base = ctx.srcDir ? "src/" : "";
  const jsx = ctx.typescript ? "tsx" : "jsx";
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

function signInPath(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
  return `${base}app/sign-in/[[...sign-in]]/page.${ext}`;
}

function signUpPath(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
  return `${base}app/sign-up/[[...sign-up]]/page.${ext}`;
}

export const nextjsApp: FrameworkScaffold = {
  name: "Next.js (App Router)",
  dep: "next",
  variant: "app-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant !== "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    actions.push(await scaffoldNextjsMiddleware(ctx));
    actions.push(await scaffoldLayout(ctx));

    actions.push(
      await scaffoldAuthPage(ctx.cwd, signInPath(ctx), nextjsSignInPageContent(), "sign-in page"),
    );
    actions.push(
      await scaffoldAuthPage(ctx.cwd, signUpPath(ctx), nextjsSignUpPageContent(), "sign-up page"),
    );

    postInstructions.push(NEXTJS_SIGN_ROUTES_INSTRUCTION);

    return { actions, postInstructions };
  },
};
