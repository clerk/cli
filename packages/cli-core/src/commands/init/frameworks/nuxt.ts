import { parseModule } from "magicast";
import {
  authComponentName,
  authFileSpecs,
  hasTailwindStyles,
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

export const nuxt: FrameworkScaffold = {
  name: "Nuxt",
  dep: "nuxt",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "nuxt",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const tailwind = hasTailwindStyles(ctx);
    const [configAction, authActions, envAction] = await Promise.all([
      scaffoldConfig(ctx),
      scaffoldAuthFiles(
        ctx.cwd,
        authFileSpecs({
          path: (kind) => `pages/${kind}/[...slug].vue`,
          content: (kind) => authPageContent(kind, tailwind),
          surface: "page",
        }),
      ),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.nuxt),
    ]);

    const postInstructions = [
      'Use <Show when="signed-in"> and <Show when="signed-out"> components in your app.vue for conditional rendering (auto-imported)',
    ];

    if (ctx.deps["@nuxtjs/i18n"]) {
      postInstructions.push(
        "@nuxtjs/i18n handles locale-prefixed routing automatically — no additional page placement needed for sign-in/sign-up",
      );
    }

    return {
      actions: [configAction, ...authActions, envAction],
      postInstructions,
    };
  },
};
