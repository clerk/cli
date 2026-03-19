import { join } from "node:path";
import { parseModule, builders } from "magicast";
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

function addClerkToIntegrationsViaAst(content: string): string | null {
  try {
    const mod = parseModule(content);
    const defaultExport = mod.exports.default;
    if (!defaultExport || typeof defaultExport !== "object") return null;
    if (!defaultExport.integrations) defaultExport.integrations = [];
    if (!Array.isArray(defaultExport.integrations)) return null;

    defaultExport.integrations.push(builders.raw("clerk()"));
    return mod.generate().code;
  } catch {
    return null;
  }
}

function addClerkToIntegrations(content: string): string {
  const astResult = addClerkToIntegrationsViaAst(content);
  if (astResult) return astResult;

  // String fallback for non-standard config shapes
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

async function scaffoldConfig(ctx: ProjectContext): Promise<FileAction> {
  const configPath = await findFirstFile(ctx.cwd, [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
  ]);

  if (!configPath) {
    return {
      type: "skip",
      path: "astro.config.mjs",
      skipReason: "No Astro config file found — create one and add clerk() integration manually",
    };
  }

  const content = await Bun.file(join(ctx.cwd, configPath)).text();

  if (content.includes("@clerk/astro")) {
    return { type: "skip", path: configPath, skipReason: "Already has @clerk/astro integration" };
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
  const file = Bun.file(join(ctx.cwd, path));

  if (!(await file.exists())) {
    return {
      path,
      type: "create",
      content: middlewareContent(),
      description: "Create Clerk middleware with onRequest export",
    };
  }

  const content = await file.text();

  if (hasClerkImport(content)) {
    return { type: "skip", path, skipReason: "Already has Clerk middleware" };
  }

  // Existing non-Clerk middleware — skip to avoid overwriting user code
  return {
    type: "skip",
    path,
    skipReason: "Existing middleware found — add clerkMiddleware() manually",
  };
}

export const astro: FrameworkScaffold = {
  name: "Astro",
  dep: "astro",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "astro",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    actions.push(await scaffoldConfig(ctx));
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
