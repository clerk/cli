import { nextjsApp } from "./frameworks/nextjs-app.js";
import { nextjsPages } from "./frameworks/nextjs-pages.js";
import { reactVite } from "./frameworks/react.js";
import { reactRouter } from "./frameworks/react-router.js";
import { nuxt } from "./frameworks/nuxt.js";
import { tanstackStart } from "./frameworks/tanstack-start.js";
import { astro } from "./frameworks/astro.js";
import { vue } from "./frameworks/vue.js";
import { javascriptVite } from "./frameworks/javascript.js";
import { expo } from "./frameworks/expo.js";
import { express } from "./frameworks/express.js";
import { fastify } from "./frameworks/fastify.js";
import { ios } from "./frameworks/ios.js";
import { android } from "./frameworks/android.js";
import { parseMajorVersion } from "./frameworks/helpers.js";
import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./frameworks/types.js";

const SCAFFOLDERS = [
  nextjsApp,
  nextjsPages,
  reactVite,
  reactRouter,
  nuxt,
  tanstackStart,
  astro,
  vue,
  javascriptVite,
  expo,
  express,
  fastify,
  ios,
  android,
] satisfies FrameworkScaffold[];

/**
 * Run the matching scaffolder's enrichContext to populate framework-specific
 * fields (variant, layoutPath, middlewareBasename) on the context.
 * Must be called before scaffold().
 */
export async function enrichProjectContext(ctx: ProjectContext): Promise<void> {
  const scaffolder = SCAFFOLDERS.find((s) => s.dep === ctx.framework.dep);
  if (scaffolder?.enrichContext) await scaffolder.enrichContext(ctx);
}

export async function scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
  const scaffolder = SCAFFOLDERS.find((s) => s.matches(ctx));

  if (!scaffolder) {
    return {
      actions: [],
      postInstructions: [
        `Scaffolding is not yet supported for ${ctx.framework.name}. Visit https://clerk.com/docs/quickstarts for setup instructions.`,
      ],
    };
  }

  const { minMajorVersion } = scaffolder;

  if (minMajorVersion !== undefined) {
    const version = ctx.deps[scaffolder.dep];
    const major = version ? parseMajorVersion(version) : null;

    if (major !== null && major < minMajorVersion) {
      return {
        actions: [],
        postInstructions: [
          `${ctx.framework.name} v${major} is below the minimum supported version (v${minMajorVersion}+). Visit https://clerk.com/docs/quickstarts for manual setup instructions.`,
        ],
      };
    }
  }

  return scaffolder.scaffold(ctx);
}
