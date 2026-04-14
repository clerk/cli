import { join } from "node:path";
import { stat } from "node:fs/promises";
import { parseModule } from "magicast";
import {
  authComponentName,
  authFileSpecs,
  findFirstFile,
  hasTailwindStyles,
  headerHtmlBlock,
  htmlAuthComponentMarkup,
  indentBlock,
  scaffoldAuthFiles,
  scaffoldConfigFile,
  scaffoldEnvVars,
  SIGN_ROUTE_ENV_VARS,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function authPageContent(kind: "sign-in" | "sign-up", tailwind: boolean): string {
  const component = authComponentName(kind);
  const content = indentBlock(htmlAuthComponentMarkup(component, tailwind), "  ");
  return `<template>
${content}
</template>
`;
}

/**
 * Determine the pages directory root for a Nuxt project.
 * Nuxt 4 moved the default srcDir to `app/`, so pages live at `app/pages/`.
 * Nuxt 3 (and Nuxt 4 with explicit srcDir overrides) keeps pages at `pages/`.
 * We detect this by checking whether the `app/` directory itself exists.
 */
async function pagesDir(cwd: string): Promise<"app/pages" | "pages"> {
  const appDirExists = await stat(join(cwd, "app"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  return appDirExists ? "app/pages" : "pages";
}

function addNuxtModule(content: string): string {
  try {
    const mod = parseModule(content);
    const defaultExport = mod.exports.default;
    if (!defaultExport || typeof defaultExport !== "object") return content;

    if (!defaultExport.modules) defaultExport.modules = [];
    if (Array.isArray(defaultExport.modules)) defaultExport.modules.push("@clerk/nuxt");
    return mod.generate().code;
  } catch {
    if (content.includes("modules:")) {
      return content.replace(/(modules:\s*\[)/, "$1\n    '@clerk/nuxt',");
    }
    return content.replace(/(defineNuxtConfig\s*\(\s*\{)/, "$1\n  modules: ['@clerk/nuxt'],");
  }
}

function scaffoldConfig(ctx: ProjectContext): Promise<FileAction> {
  return scaffoldConfigFile(ctx.cwd, {
    candidates: ["nuxt.config.ts", "nuxt.config.js"],
    existsCheck: "@clerk/nuxt",
    modify: addNuxtModule,
    description: "Add @clerk/nuxt to modules array",
    existingSkipReason: "Already has @clerk/nuxt module",
    missingAction: {
      type: "skip",
      path: "nuxt.config.ts",
      skipReason: "No Nuxt config file found — create one and add @clerk/nuxt to modules",
    },
  });
}

/**
 * Ensure app.vue has `<NuxtPage />` so file-based routing works.
 * The minimal Nuxt template uses `<NuxtWelcome />` without a router
 * outlet, which means pages/ routes never render.
 */
async function scaffoldAppVue(ctx: ProjectContext, tailwind: boolean): Promise<FileAction | null> {
  const appPath = await findFirstFile(ctx.cwd, ["app/app.vue", "app.vue"]);
  if (!appPath) return null;

  const content = await Bun.file(join(ctx.cwd, appPath)).text();

  if (content.includes("<NuxtPage")) {
    return { type: "skip", path: appPath, skipReason: "Already has <NuxtPage />" };
  }

  if (!content.includes("<NuxtWelcome")) return null;

  if (ctx.isBootstrap) {
    const header = headerHtmlBlock("    ", tailwind);
    return {
      path: appPath,
      type: "modify",
      content: `<template>
${header}
    <NuxtPage />
</template>
`,
      description: "Replace <NuxtWelcome /> with <NuxtPage /> and add auth header",
    };
  }

  const updated = content.replace(/<NuxtWelcome\s*\/?>/, "<NuxtPage />");
  return {
    path: appPath,
    type: "modify",
    content: updated,
    description: "Replace <NuxtWelcome /> with <NuxtPage /> for file-based routing",
  };
}

async function scaffoldIndexPage(cwd: string, pagesRoot: string): Promise<FileAction> {
  const indexPath = `${pagesRoot}/index.vue`;
  if (await Bun.file(join(cwd, indexPath)).exists()) {
    return { type: "skip", path: indexPath, skipReason: "Index page already exists" };
  }
  return {
    type: "create",
    path: indexPath,
    content: `<template>
  <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: calc(100vh - 65px); font-family: system-ui, sans-serif;">
    <h1>It works!</h1>
    <p>Edit <code>${indexPath}</code> to get started.</p>
  </div>
</template>
`,
    description: "Create index page so the root route renders",
  };
}

export const nuxt: FrameworkScaffold = {
  name: "Nuxt",
  dep: "nuxt",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "nuxt",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const tailwind = hasTailwindStyles(ctx);
    const pagesRoot = await pagesDir(ctx.cwd);
    const [configAction, appVueAction, authActions, envAction, indexAction] = await Promise.all([
      scaffoldConfig(ctx),
      scaffoldAppVue(ctx, tailwind),
      scaffoldAuthFiles(
        ctx.cwd,
        authFileSpecs({
          // Use catch-all routes so Clerk can handle sub-paths (e.g. /sign-in/factor-one).
          // Place pages under app/pages/ for Nuxt 4's app/ directory layout, or pages/ for Nuxt 3.
          path: (kind) => `${pagesRoot}/${kind}/[...slug].vue`,
          content: (kind) => authPageContent(kind, tailwind),
          surface: "page",
        }),
      ),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.nuxt),
      ctx.isBootstrap ? scaffoldIndexPage(ctx.cwd, pagesRoot) : Promise.resolve(null),
    ]);

    const actions = [configAction, appVueAction, indexAction, ...authActions, envAction].filter(
      (action): action is FileAction => action !== null,
    );

    const postInstructions: string[] = [];

    if (!appVueAction) {
      postInstructions.push(
        "Ensure your app.vue (or app/app.vue) includes <NuxtPage /> so file-based routes render",
      );
    }

    if (!ctx.isBootstrap) {
      postInstructions.push(
        'Use <Show when="signed-in"> and <Show when="signed-out"> components in your app.vue for conditional rendering (auto-imported)',
      );
    }

    if (ctx.deps["@nuxtjs/i18n"]) {
      postInstructions.push(
        "@nuxtjs/i18n handles locale-prefixed routing automatically — no additional page placement needed for sign-in/sign-up",
      );
    }

    return { actions, postInstructions };
  },
};
