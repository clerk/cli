import { join } from "node:path";
import { scaffoldServerFramework, type ServerFrameworkConfig } from "./node-server.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

const EXPRESS_CONFIG: ServerFrameworkConfig = {
  clerkPackage: "@clerk/express",
  clerkImport: "clerkMiddleware",
  // Matches `express()` and the inline-require form `require("express")()`,
  // with an optional type annotation (`const app: Express = express()`).
  creationPattern:
    /(?:const|let|var)\s+(\w+)(?:\s*:\s*[\w$.]+(?:<[^>]*>)?)?\s*=\s*(?:express|require\(\s*["']express["']\s*\))\s*\(\s*\)/,
  frameworkPackage: "express",
  attachStatement: (appVar) => `${appVar}.use(clerkMiddleware());`,
  description: "Add clerkMiddleware() to Express app",
  docsUrl: "https://clerk.com/docs/expressjs/getting-started/quickstart",
  manualWiring: "Add `app.use(clerkMiddleware())` from @clerk/express to your server entry file.",
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
    const [plan, typesAction] = await Promise.all([
      scaffoldServerFramework(ctx, EXPRESS_CONFIG),
      scaffoldTypesReference(ctx),
    ]);

    if (typesAction) {
      plan.actions.push(typesAction);
      // A tsconfig scoped to `include: ["src"]` never loads the file, and the
      // failure is silent — `req.auth` stops type-checking with a file on disk
      // that looks like it should have fixed it.
      plan.postInstructions.push(
        `Make sure \`${TYPES_REFERENCE_PATH}\` is covered by your tsconfig \`include\` — otherwise the \`req.auth\` type augmentation won't apply`,
      );
    }

    return plan;
  },
};
