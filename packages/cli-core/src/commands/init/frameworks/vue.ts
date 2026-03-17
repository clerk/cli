import { join } from "node:path";
import { findFirstFile, safeAddImport } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const base = ctx.srcDir ? "src/" : "";
  return findFirstFile(ctx.cwd, [`${base}main.ts`, `${base}main.js`]);
}

function addClerkPluginSetup(source: string): string {
  const keyBlock = `\nconst PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;\n\nif (!PUBLISHABLE_KEY) {\n  throw new Error("Add your Clerk Publishable Key to the .env file");\n}\n`;

  // Insert app.use(clerkPlugin, ...) before app.mount()
  let result = source.replace(
    /((\w+)\.mount\s*\()/,
    `$2.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });\n$1`,
  );

  // Insert key block after last import
  const lastImportIdx = result.lastIndexOf("import ");
  const lineEnd = result.indexOf("\n", lastImportIdx);
  if (lineEnd === -1) return result;

  return result.slice(0, lineEnd + 1) + keyBlock + result.slice(lineEnd + 1);
}

async function scaffoldEntry(ctx: ProjectContext): Promise<FileAction | null> {
  const entryPath = await findEntryFile(ctx);
  if (!entryPath) return null;

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("clerkPlugin") || content.includes("@clerk/vue")) {
    return {
      path: entryPath,
      type: "modify",
      content,
      description: "Add clerkPlugin to Vue app",
      skipReason: "Already has Clerk plugin",
    };
  }

  let newContent = safeAddImport(content, "@clerk/vue", "clerkPlugin");

  // Add the publishable key constant and app.use() call before app.mount()
  if (newContent.includes(".mount(")) {
    newContent = addClerkPluginSetup(newContent);
  }

  return {
    path: entryPath,
    type: "modify",
    content: newContent,
    description: "Add clerkPlugin with publishableKey to Vue app",
  };
}

export const vue: FrameworkScaffold = {
  name: "Vue",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const entryAction = await scaffoldEntry(ctx);
    if (entryAction) {
      actions.push(entryAction);
    } else {
      postInstructions.push(
        "Add `import { clerkPlugin } from '@clerk/vue'` and `app.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY })` to your main.ts. See: https://clerk.com/docs/quickstarts/vue",
      );
    }

    postInstructions.push(
      "Use <Show>, <SignInButton>, <SignUpButton>, <UserButton> from @clerk/vue in your components",
    );

    return { actions, postInstructions };
  },
};
