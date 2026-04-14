import { join } from "node:path";
import { parseModule, builders } from "magicast";
import {
  authComponentName,
  authFileSpecs,
  findFirstFile,
  hasClerkImport,
  hasTailwindStyles,
  headerHtmlBlock,
  htmlAuthComponentMarkup,
  scaffoldAuthFiles,
  scaffoldConfigFile,
  scaffoldEnvVars,
  scriptExt,
  SIGN_ROUTE_ENV_VARS,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function middlewareContent(): string {
  return `import { clerkMiddleware } from "@clerk/astro/server";

export const onRequest = clerkMiddleware();
`;
}

function authPageContent(kind: "sign-in" | "sign-up", tailwind: boolean): string {
  const component = authComponentName(kind);

  return `---
import { ${component} } from "@clerk/astro/components";
---

${htmlAuthComponentMarkup(component, tailwind)}
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

function enableServerOutput(content: string): string {
  if (content.includes("output:")) return content;
  return content.replace(/(defineConfig\s*\(\s*\{)/, '$1\n  output: "server",');
}

function addClerkIntegration(content: string, enableSsr = false): string {
  let result = addClerkToIntegrations(addClerkImport(content));
  if (enableSsr) result = enableServerOutput(result);
  return result;
}

function scaffoldConfig(ctx: ProjectContext): Promise<FileAction> {
  return scaffoldConfigFile(ctx.cwd, {
    candidates: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
    existsCheck: "@clerk/astro",
    modify: (content) => addClerkIntegration(content, Boolean(ctx.isBootstrap)),
    description: ctx.isBootstrap
      ? "Add clerk() to integrations, import, and enable SSR output"
      : "Add clerk() to integrations and import",
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

const ASTRO_HEADER_IMPORT = `import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/astro/components";`;

/** Inject a frontmatter import line into an Astro file. */
function addAstroFrontmatterImport(content: string, importLine: string): string {
  const fencePattern = /^---\n([\s\S]*?)^---/m;
  const match = fencePattern.exec(content);
  if (match) {
    const [fullMatch, frontmatter = ""] = match;
    if (frontmatter.includes(importLine)) return content;
    return content.replace(fullMatch!, `---\n${frontmatter}${importLine}\n---`);
  }
  return `---\n${importLine}\n---\n\n${content}`;
}

/**
 * Inject an auth header into the Astro layout file during bootstrap.
 * Adds the necessary component import and inserts the header before `<slot />`.
 */
async function scaffoldLayout(ctx: ProjectContext, tailwind: boolean): Promise<FileAction | null> {
  if (!ctx.isBootstrap) return null;

  const layoutPath = await findFirstFile(ctx.cwd, ["src/layouts/Layout.astro"]);
  if (!layoutPath) return null;

  let content = await Bun.file(join(ctx.cwd, layoutPath)).text();

  if (!content.includes("<slot")) return null;

  content = addAstroFrontmatterImport(content, ASTRO_HEADER_IMPORT);

  const header = headerHtmlBlock("\t\t", tailwind);
  content = content.replace(/(\s*)(<slot\s*\/?>)/, `\n${header}\n$1$2`);

  return {
    path: layoutPath,
    type: "modify",
    content,
    description: "Add auth header with Clerk components to layout",
  };
}

/** Check if the Astro config contains an i18n configuration. */
async function hasAstroI18n(cwd: string): Promise<boolean> {
  const configPath = await findFirstFile(cwd, [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
  ]);
  if (!configPath) return false;

  const content = await Bun.file(join(cwd, configPath)).text();
  // Strip comments before matching to avoid false positives on commented-out config
  const stripped = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return /\bi18n\s*:/.test(stripped);
}

export const astro: FrameworkScaffold = {
  name: "Astro",
  dep: "astro",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "astro",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const tailwind = hasTailwindStyles(ctx);
    const [configAction, middlewareAction, layoutAction, authActions, envAction, i18n] =
      await Promise.all([
        scaffoldConfig(ctx),
        scaffoldMiddleware(ctx),
        scaffoldLayout(ctx, tailwind),
        scaffoldAuthFiles(
          ctx.cwd,
          authFileSpecs({
            path: (kind) => `src/pages/${kind}.astro`,
            content: (kind) => authPageContent(kind, tailwind),
            surface: "page",
          }),
        ),
        scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.astro),
        hasAstroI18n(ctx.cwd),
      ]);

    const actions = [
      configAction,
      middlewareAction,
      layoutAction,
      ...authActions,
      envAction,
    ].filter((action): action is FileAction => action !== null);

    const postInstructions = [
      "Ensure your Astro config has `output: 'server'` and an SSR adapter (e.g., @astrojs/node)",
    ];

    if (i18n) {
      postInstructions.push(
        "Your project uses i18n routing — create sign-in/sign-up pages in each locale folder (e.g., src/pages/en/sign-in.astro)",
      );
    }

    return {
      actions,
      postInstructions,
    };
  },
};
