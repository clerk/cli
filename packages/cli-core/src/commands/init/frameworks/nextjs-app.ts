import { join } from "node:path";
import {
  NEXTJS_SIGN_ROUTES_INSTRUCTION,
  nextjsSignInPageContent,
  nextjsSignUpPageContent,
  safeAddImport,
  scaffoldAuthPage,
  scaffoldNextjsMiddleware,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function scaffoldLayout(ctx: ProjectContext): Promise<FileAction | null> {
  if (!ctx.layoutPath) return null;

  const fullPath = join(ctx.cwd, ctx.layoutPath);
  const file = Bun.file(fullPath);
  if (!(await file.exists())) return null;

  const content = await file.text();

  if (content.includes("ClerkProvider")) {
    return {
      path: ctx.layoutPath,
      type: "modify",
      content,
      description: "Add ClerkProvider to layout",
      skipReason: "Already has ClerkProvider",
    };
  }

  let newContent = safeAddImport(content, "@clerk/nextjs", "ClerkProvider");

  if (newContent.includes("<body")) {
    newContent = newContent.replace(/(<body[^>]*>)(\s*)/, "$1$2<ClerkProvider>\n");
    newContent = newContent.replace(/(\s*)(<\/body>)/, "\n</ClerkProvider>$1$2");
  } else {
    return {
      path: ctx.layoutPath,
      type: "modify",
      content: newContent,
      description: "Add ClerkProvider import (manual wrapping needed)",
    };
  }

  return {
    path: ctx.layoutPath,
    type: "modify",
    content: newContent,
    description: "Add ClerkProvider import and wrap body contents",
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

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    actions.push(await scaffoldNextjsMiddleware(ctx));

    const layoutAction = await scaffoldLayout(ctx);
    if (layoutAction) {
      actions.push(layoutAction);
    } else {
      postInstructions.push(
        "Wrap your root layout with <ClerkProvider> from @clerk/nextjs. See: https://clerk.com/docs/quickstarts/nextjs",
      );
    }

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
