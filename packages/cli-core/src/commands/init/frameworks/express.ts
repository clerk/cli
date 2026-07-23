import { join } from "node:path";
import { scaffoldServerEntry, type ServerFrameworkConfig } from "./node-server.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

const EXPRESS_CONFIG: ServerFrameworkConfig = {
  clerkPackage: "@clerk/express",
  clerkImport: "clerkMiddleware",
  // Matches `express()` and the inline-require form `require("express")()`.
  creationPattern:
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:express|require\(\s*["']express["']\s*\))\s*\(\s*\)/,
  frameworkPackage: "express",
  attachStatement: (appVar) => `${appVar}.use(clerkMiddleware());`,
  description: "Add clerkMiddleware() to Express app",
};

const TYPES_REFERENCE_PATH = "types/globals.d.ts";
const TYPES_REFERENCE_CONTENT = `/// <reference types="@clerk/express/env" />\n`;

/** Register the Express request type augmentation (from the official quickstart). */
async function scaffoldTypesReference(ctx: ProjectContext): Promise<FileAction | null> {
  if (!ctx.typescript) return null;

  if (await Bun.file(join(ctx.cwd, TYPES_REFERENCE_PATH)).exists()) {
    return {
      type: "skip",
      path: TYPES_REFERENCE_PATH,
      skipReason: "Type reference file already exists",
    };
  }

  return {
    type: "create",
    path: TYPES_REFERENCE_PATH,
    content: TYPES_REFERENCE_CONTENT,
    description: "Add @clerk/express request type augmentation",
  };
}

export const express: FrameworkScaffold = {
  name: "Express",
  dep: "express",

  matches: (ctx) => ctx.framework.dep === "express",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [entryAction, typesAction] = await Promise.all([
      scaffoldServerEntry(ctx, EXPRESS_CONFIG),
      scaffoldTypesReference(ctx),
    ]);

    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    if (entryAction) {
      actions.push(entryAction);
    } else {
      postInstructions.push(
        "Add `app.use(clerkMiddleware())` from @clerk/express to your server entry file. See: https://clerk.com/docs/expressjs/getting-started/quickstart",
      );
    }
    if (typesAction) actions.push(typesAction);

    postInstructions.push(
      `Ensure ${ctx.framework.envVar} and CLERK_SECRET_KEY are set in your ${ctx.envFile} (pulled via \`clerk env pull\`), and load them before Clerk imports — e.g. \`node --env-file=${ctx.envFile} index.js\``,
      "Protect routes with `getAuth()` and `clerkClient`: https://clerk.com/docs/expressjs/getting-started/quickstart",
    );

    return { actions, postInstructions };
  },
};
