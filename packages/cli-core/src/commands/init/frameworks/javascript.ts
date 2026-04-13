import { join } from "node:path";
import { findFirstFile, scriptExt, srcPrefix } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const base = srcPrefix(ctx);
  const ext = scriptExt(ctx);
  return findFirstFile(ctx.cwd, [`${base}main.${ext}`]);
}

/**
 * Generate Clerk JS initialization code following the official quickstart:
 * https://clerk.com/docs/js-frontend/getting-started/quickstart
 *
 * Uses innerHTML to mount Clerk components into the DOM — this is safe because
 * the content is a static string literal (no user input), matching the pattern
 * from the official Clerk JS quickstart documentation.
 */
function clerkInitContent(typescript: boolean): string {
  const castDiv = typescript ? " as HTMLDivElement" : "";
  // Static template strings with no user input — safe for innerHTML
  return `import { Clerk } from "@clerk/clerk-js";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY. Add your key to .env.local.\\nRun: 1) clerk auth login  2) clerk link  3) clerk env pull — then restart the dev server.");
}

const clerk = new Clerk(publishableKey);
await clerk.load();

// Static string literals with no user input — safe to use as markup
if (clerk.user) {
  const div = document.getElementById("app")${castDiv};
  div.innerHTML = '<div id="user-button"></div>';
  clerk.mountUserButton(document.getElementById("user-button")${castDiv});
} else {
  const div = document.getElementById("app")${castDiv};
  div.innerHTML = '<div id="sign-in"></div>';
  clerk.mountSignIn(document.getElementById("sign-in")${castDiv});
}
`;
}

async function scaffoldEntry(ctx: ProjectContext): Promise<FileAction | null> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return null;

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("@clerk/clerk-js")) {
    return { type: "skip", path: entryPath, skipReason: "Already has Clerk JS" };
  }

  return {
    path: entryPath,
    type: "modify",
    content: clerkInitContent(ctx.typescript),
    description: "Replace with Clerk JS initialization",
  };
}

export const javascriptVite: FrameworkScaffold = {
  name: "JavaScript (Vite)",
  dep: "vite",

  matches: (ctx) => ctx.framework.dep === "vite",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const entryAction = await scaffoldEntry(ctx);
    if (entryAction) {
      actions.push(entryAction);
    } else {
      postInstructions.push(
        "Initialize Clerk in your entry file (e.g., src/main.ts). See: https://clerk.com/docs/js-frontend/getting-started/quickstart",
      );
    }

    postInstructions.push(
      `Ensure ${ctx.framework.envVar} is set in your ${ctx.envFile} (pulled via \`clerk env pull\`)`,
    );

    return { actions, postInstructions };
  },
};
