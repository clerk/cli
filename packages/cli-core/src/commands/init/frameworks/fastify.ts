import { scaffoldServerEntry, type ServerFrameworkConfig } from "./node-server.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

const FASTIFY_CONFIG: ServerFrameworkConfig = {
  clerkPackage: "@clerk/fastify",
  clerkImport: "clerkPlugin",
  // Matches `Fastify(...)`/`fastify(...)` and the inline-require form
  // `require("fastify")(...)`.
  creationPattern:
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:[Ff]astify|require\(\s*["']fastify["']\s*\))\s*\(/,
  frameworkPackage: "fastify",
  attachStatement: (appVar) => `${appVar}.register(clerkPlugin);`,
  description: "Register clerkPlugin on Fastify app",
};

export const fastify: FrameworkScaffold = {
  name: "Fastify",
  dep: "fastify",

  matches: (ctx) => ctx.framework.dep === "fastify",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const entryAction = await scaffoldServerEntry(ctx, FASTIFY_CONFIG);

    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    if (entryAction) {
      actions.push(entryAction);
    } else {
      postInstructions.push(
        "Register `clerkPlugin` from @clerk/fastify on your Fastify instance. See: https://clerk.com/docs/fastify/getting-started/quickstart",
      );
    }

    postInstructions.push(
      `Ensure ${ctx.framework.envVar} and CLERK_SECRET_KEY are set in your ${ctx.envFile} (pulled via \`clerk env pull\`), and load them before Clerk imports — e.g. \`node --env-file=${ctx.envFile} index.js\``,
      "Protect routes with `getAuth()` and `clerkClient`: https://clerk.com/docs/fastify/getting-started/quickstart",
    );

    return { actions, postInstructions };
  },
};
