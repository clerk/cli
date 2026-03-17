import { join } from "node:path";
import { findFirstFile, safeAddImport } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
  return findFirstFile(ctx.cwd, [
    `${base}main.${ext}`,
    `${base}main.${ctx.typescript ? "ts" : "js"}`,
  ]);
}

async function scaffoldEntry(ctx: ProjectContext): Promise<FileAction | null> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return null;

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("ClerkProvider")) {
    return {
      path: entryPath,
      type: "modify",
      content,
      description: "Add ClerkProvider to entry",
      skipReason: "Already has ClerkProvider",
    };
  }

  let newContent = safeAddImport(content, "@clerk/react", "ClerkProvider");

  if (newContent.includes("<StrictMode>")) {
    newContent = newContent.replace(
      /(<StrictMode>)(\s*)/,
      '$1$2<ClerkProvider afterSignOutUrl="/">\n',
    );
    newContent = newContent.replace(/(\s*)(<\/StrictMode>)/, "\n</ClerkProvider>$1$2");
  } else if (newContent.includes("<App")) {
    newContent = newContent.replace(
      /(<App\s*\/>)/,
      '<ClerkProvider afterSignOutUrl="/">\n      $1\n    </ClerkProvider>',
    );
  }

  return {
    path: entryPath,
    type: "modify",
    content: newContent,
    description: "Add ClerkProvider import and wrap app root",
  };
}

export const reactVite: FrameworkScaffold = {
  name: "React (Vite)",

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
