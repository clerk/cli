import { join } from "node:path";
import { parseModule } from "magicast";
import { findFirstFile, scaffoldAuthPage } from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function signInPageContent(): string {
  return `<template>
  <SignIn />
</template>
`;
}

function signUpPageContent(): string {
  return `<template>
  <SignUp />
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

async function scaffoldConfig(ctx: ProjectContext): Promise<FileAction> {
  const configPath = await findFirstFile(ctx.cwd, ["nuxt.config.ts", "nuxt.config.js"]);

  if (!configPath) {
    return {
      type: "skip",
      path: "nuxt.config.ts",
      skipReason: "No Nuxt config file found — create one and add @clerk/nuxt to modules",
    };
  }

  const content = await Bun.file(join(ctx.cwd, configPath)).text();

  if (content.includes("@clerk/nuxt")) {
    return { type: "skip", path: configPath, skipReason: "Already has @clerk/nuxt module" };
  }

  const newContent = addNuxtModule(content);

  return {
    path: configPath,
    type: "modify",
    content: newContent,
    description: "Add @clerk/nuxt to modules array",
  };
}

export const nuxt: FrameworkScaffold = {
  name: "Nuxt",
  dep: "nuxt",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "nuxt",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    actions.push(await scaffoldConfig(ctx));

    actions.push(
      await scaffoldAuthPage(ctx.cwd, "pages/sign-in.vue", signInPageContent(), "sign-in page"),
    );
    actions.push(
      await scaffoldAuthPage(ctx.cwd, "pages/sign-up.vue", signUpPageContent(), "sign-up page"),
    );

    postInstructions.push(
      'Use <Show when="signed-in"> and <Show when="signed-out"> components in your app.vue for conditional rendering (auto-imported)',
    );

    return { actions, postInstructions };
  },
};
