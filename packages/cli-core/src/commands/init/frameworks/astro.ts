import { join } from "node:path";
import { parseModule } from "magicast";
import { findFirstFile, hasClerkImport, scaffoldAuthPage } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function middlewareContent(): string {
  return `import { clerkMiddleware } from "@clerk/astro/server";

export const onRequest = clerkMiddleware();
`;
}

function signInPageContent(): string {
  return `---
import { SignIn } from "@clerk/astro/components";
---

<SignIn />
`;
}

function signUpPageContent(): string {
  return `---
import { SignUp } from "@clerk/astro/components";
---

<SignUp />
`;
}

function addClerkImport(content: string): string {
  try {
    const mod = parseModule(content);
    mod.imports.$add({ from: "@clerk/astro", imported: "default", local: "clerk" });
    return mod.generate().code;
  } catch {
    return `import clerk from "@clerk/astro";\n${content}`;
  }
}

function addClerkToIntegrations(content: string): string {
  if (content.includes("integrations:")) {
    return content.replace(/(integrations:\s*\[)/, "$1clerk(), ");
  }
  if (content.includes("defineConfig")) {
    return content.replace(/(defineConfig\s*\(\s*\{)/, "$1\n  integrations: [clerk()],");
  }
  return content;
}

function addClerkIntegration(content: string): string {
  return addClerkToIntegrations(addClerkImport(content));
}

async function scaffoldConfig(ctx: ProjectContext): Promise<FileAction | null> {
  const configPath = await findFirstFile(ctx.cwd, [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
  ]);
  if (!configPath) return null;

  const content = await Bun.file(join(ctx.cwd, configPath)).text();

  if (content.includes("@clerk/astro")) {
    return {
      path: configPath,
      type: "modify",
      content,
      description: "Add clerk() integration",
      skipReason: "Already has @clerk/astro integration",
    };
  }

  const newContent = addClerkIntegration(content);

  return {
    path: configPath,
    type: "modify",
    content: newContent,
    description: "Add clerk() to integrations and import",
  };
}

async function scaffoldMiddleware(ctx: ProjectContext): Promise<FileAction> {
  const ext = ctx.typescript ? "ts" : "js";
  const path = `src/middleware.${ext}`;
  const fullPath = join(ctx.cwd, path);

  const file = Bun.file(fullPath);
  if (await file.exists()) {
    const content = await file.text();
    if (hasClerkImport(content)) {
      return {
        path,
        type: "modify",
        content: "",
        description: "Create Clerk middleware",
        skipReason: "Already has Clerk middleware",
      };
    }

    // Existing non-Clerk middleware — skip to avoid overwriting user code
    return {
      path,
      type: "modify",
      content: "",
      description: "Create Clerk middleware",
      skipReason: "Existing middleware found — add clerkMiddleware() manually",
    };
  }

  return {
    path,
    type: "create",
    content: middlewareContent(),
    description: "Create Clerk middleware with onRequest export",
  };
}

export const astro: FrameworkScaffold = {
  name: "Astro",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const configAction = await scaffoldConfig(ctx);
    if (configAction) {
      actions.push(configAction);
    } else {
      postInstructions.push(
        "Add `import clerk from '@clerk/astro'` and `clerk()` to integrations in astro.config.mjs. See: https://clerk.com/docs/quickstarts/astro",
      );
    }

    actions.push(await scaffoldMiddleware(ctx));
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        "src/pages/sign-in.astro",
        signInPageContent(),
        "sign-in page",
      ),
    );
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        "src/pages/sign-up.astro",
        signUpPageContent(),
        "sign-up page",
      ),
    );

    postInstructions.push(
      "Ensure your Astro config has `output: 'server'` and an SSR adapter (e.g., @astrojs/node)",
    );

    return { actions, postInstructions };
  },
};
