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

async function scaffoldConfig(ctx: ProjectContext): Promise<FileAction | null> {
  const configPath = await findFirstFile(ctx.cwd, ["nuxt.config.ts", "nuxt.config.js"]);
  if (!configPath) return null;

  const content = await Bun.file(join(ctx.cwd, configPath)).text();

  if (content.includes("@clerk/nuxt")) {
    return {
      path: configPath,
      type: "modify",
      content,
      description: "Add @clerk/nuxt to modules",
      skipReason: "Already has @clerk/nuxt module",
    };
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

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const configAction = await scaffoldConfig(ctx);
    if (configAction) {
      actions.push(configAction);
    } else {
      postInstructions.push(
        "Add '@clerk/nuxt' to the modules array in your nuxt.config.ts. See: https://clerk.com/docs/quickstarts/nuxt",
      );
    }

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
