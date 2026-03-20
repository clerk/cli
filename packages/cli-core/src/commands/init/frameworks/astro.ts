import { join } from "node:path";
import { parseModule, builders } from "magicast";
import {
  authComponentName,
  hasClerkImport,
  scaffoldAuthFiles,
  scaffoldConfigFile,
  scriptExt,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function middlewareContent(): string {
  return `import { clerkMiddleware } from "@clerk/astro/server";

export const onRequest = clerkMiddleware();
`;
}

function authPageContent(kind: "sign-in" | "sign-up"): string {
  const component = authComponentName(kind);

  return `---
import { ${component} } from "@clerk/astro/components";
---

<${component} />
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

function scaffoldConfig(ctx: ProjectContext): Promise<FileAction> {
  return scaffoldConfigFile(ctx.cwd, {
    candidates: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
    existsCheck: "@clerk/astro",
    modify: addClerkIntegration,
    description: "Add clerk() to integrations and import",
    existingSkipReason: "Already has @clerk/astro integration",
    missingAction: {
      type: "skip",
      path: "astro.config.mjs",
      skipReason: "No Astro config file found — create one and add clerk() integration manually",
    },
  });
}

async function scaffoldMiddleware(ctx: ProjectContext): Promise<FileAction> {
  const ext = scriptExt(ctx);
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
    const [configAction, middlewareAction, authActions] = await Promise.all([
      scaffoldConfig(ctx),
      scaffoldMiddleware(ctx),
      scaffoldAuthFiles(ctx.cwd, [
        {
          path: "src/pages/sign-in.astro",
          content: authPageContent("sign-in"),
          kind: "sign-in",
          surface: "page",
        },
        {
          path: "src/pages/sign-up.astro",
          content: authPageContent("sign-up"),
          kind: "sign-up",
          surface: "page",
        },
      ]),
    ]);

    return {
      actions: [configAction, middlewareAction, ...authActions],
      postInstructions: [
        "Ensure your Astro config has `output: 'server'` and an SSR adapter (e.g., @astrojs/node)",
      ],
    };
  },
};
