import { parseModule } from "magicast";
import { authComponentName, scaffoldAuthFiles, scaffoldConfigFile } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function authPageContent(kind: "sign-in" | "sign-up"): string {
  const component = authComponentName(kind);
  return `<template>
  <${component} />
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
    const [configAction, authActions] = await Promise.all([
      scaffoldConfig(ctx),
      scaffoldAuthFiles(ctx.cwd, [
        {
          path: "pages/sign-in.vue",
          content: authPageContent("sign-in"),
          kind: "sign-in",
          surface: "page",
        },
        {
          path: "pages/sign-up.vue",
          content: authPageContent("sign-up"),
          kind: "sign-up",
          surface: "page",
        },
      ]),
    ]);

    return {
      actions: [configAction, ...authActions],
      postInstructions: [
        'Use <Show when="signed-in"> and <Show when="signed-out"> components in your app.vue for conditional rendering (auto-imported)',
      ],
    };
  },
};
