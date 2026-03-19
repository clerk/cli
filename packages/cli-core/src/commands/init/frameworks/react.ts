import { join } from "node:path";
import { findFirstFile, safeAddImport } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const base = ctx.srcDir ? "src/" : "";
  const jsx = ctx.typescript ? "tsx" : "jsx";
  const ext = ctx.typescript ? "ts" : "js";
  return findFirstFile(ctx.cwd, [`${base}main.${jsx}`, `${base}main.${ext}`]);
}

function wrapWithClerkProvider(content: string): string {
  if (content.includes("<StrictMode>")) {
    let result = content.replace(
      /(<StrictMode>)(\s*)/,
      '$1$2<ClerkProvider afterSignOutUrl="/">\n',
    );
    return result.replace(/(\s*)(<\/StrictMode>)/, "\n</ClerkProvider>$1$2");
  }

  if (content.includes("<App")) {
    return content.replace(
      /(<App\s*\/>)/,
      '<ClerkProvider afterSignOutUrl="/">\n      $1\n    </ClerkProvider>',
    );
  }

  return content;
}

async function scaffoldEntry(ctx: ProjectContext): Promise<FileAction | null> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return null;

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path: entryPath, skipReason: "Already has ClerkProvider" };
  }

  const imported = safeAddImport(content, "@clerk/react", "ClerkProvider");
  const newContent = wrapWithClerkProvider(imported);

  return {
    path: entryPath,
    type: "modify",
    content: newContent,
    description: "Add ClerkProvider import and wrap app root",
  };
}

export const reactVite: FrameworkScaffold = {
  name: "React (Vite)",
  dep: "react",
  minMajorVersion: 18,

  matches: (ctx) => ctx.framework.dep === "react",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const entryAction = await scaffoldEntry(ctx);
    if (entryAction) {
      actions.push(entryAction);
    } else {
      postInstructions.push(
        `Wrap your app root with <ClerkProvider> from @clerk/react in your entry file (e.g., main.tsx). See: https://clerk.com/docs/quickstarts/react`,
      );
    }

    postInstructions.push(
      `Ensure ${ctx.framework.envVar} is set in your ${ctx.envFile} (pulled via \`clerk env pull\`)`,
    );

    return { actions, postInstructions };
  },
};
