import { nextjsApp } from "./frameworks/nextjs-app.js";
import { nextjsPages } from "./frameworks/nextjs-pages.js";
import { reactVite } from "./frameworks/react.js";
import { reactRouter } from "./frameworks/react-router.js";
import { nuxt } from "./frameworks/nuxt.js";
import { tanstackStart } from "./frameworks/tanstack-start.js";
import { astro } from "./frameworks/astro.js";
import { vue } from "./frameworks/vue.js";
import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./frameworks/types.js";

const SCAFFOLDS: Record<string, FrameworkScaffold> = {
  "next:app-router": nextjsApp,
  "next:pages-router": nextjsPages,
  react: reactVite,
  "react-router": reactRouter,
  nuxt: nuxt,
  "@tanstack/react-start": tanstackStart,
  astro: astro,
  vue: vue,
};

export function getScaffoldKey(ctx: ProjectContext): string {
  if (ctx.framework.dep === "next") {
    return `next:${ctx.variant ?? "app-router"}`;
  }
  return ctx.framework.dep;
}

export async function scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
  const key = getScaffoldKey(ctx);
  const scaffolder = SCAFFOLDS[key];

  if (!scaffolder) {
    return {
      actions: [],
      postInstructions: [
        `Scaffolding is not yet supported for ${ctx.framework.name}. Visit https://clerk.com/docs/quickstarts for setup instructions.`,
      ],
    };
  }

  return scaffolder.scaffold(ctx);
}
