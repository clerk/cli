import type { ProjectContext } from "../frameworks/types.js";

// Static text imports — embedded at build time, safe for compiled binaries.
import genericMd from "./generic.md" with { type: "text" };
import genericFallbackMd from "./generic-fallback.md" with { type: "text" };
import nextjsAppRouterMd from "./nextjs-app-router.md" with { type: "text" };
import nextjsPagesRouterMd from "./nextjs-pages-router.md" with { type: "text" };
import reactMd from "./react.md" with { type: "text" };
import reactRouterMd from "./react-router.md" with { type: "text" };
import nuxtMd from "./nuxt.md" with { type: "text" };
import tanstackStartMd from "./tanstack-start.md" with { type: "text" };
import astroMd from "./astro.md" with { type: "text" };
import vueMd from "./vue.md" with { type: "text" };
import expoMd from "./expo.md" with { type: "text" };
import expressMd from "./express.md" with { type: "text" };
import fastifyMd from "./fastify.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

const TEMPLATES: Record<string, string> = {
  generic: genericMd,
  "generic-fallback": genericFallbackMd,
  "nextjs-app-router": nextjsAppRouterMd,
  "nextjs-pages-router": nextjsPagesRouterMd,
  react: reactMd,
  "react-router": reactRouterMd,
  nuxt: nuxtMd,
  "tanstack-start": tanstackStartMd,
  astro: astroMd,
  vue: vueMd,
  expo: expoMd,
  express: expressMd,
  fastify: fastifyMd,
};

function loadTemplate(name: string): string {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown prompt template: ${name}`);
  // The project formatter escapes underscores in markdown headings (e.g. `_app` → `\_app`).
  // These templates are output as plain text, so undo that escaping.
  return template.replaceAll("\\_", "_");
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PM_COMMANDS: Record<ProjectContext["packageManager"], string> = {
  bun: "bun add",
  yarn: "yarn add",
  pnpm: "pnpm add",
  npm: "npm install",
};

export function pmInstallCommand(pm: ProjectContext["packageManager"]): string {
  return PM_COMMANDS[pm];
}

// Maps framework dep to its template filename and docs URL.
// Next.js defaults to app-router; pages-router variant is handled in resolveTemplate.
const FRAMEWORK_PROMPTS: Record<string, { template: string; docsUrl: string }> = {
  next: {
    template: "nextjs-app-router",
    docsUrl: "https://clerk.com/docs/nextjs/getting-started/quickstart",
  },
  react: { template: "react", docsUrl: "https://clerk.com/docs/react/getting-started/quickstart" },
  "react-router": {
    template: "react-router",
    docsUrl: "https://clerk.com/docs/react-router/getting-started/quickstart",
  },
  nuxt: { template: "nuxt", docsUrl: "https://clerk.com/docs/nuxt/getting-started/quickstart" },
  "@tanstack/react-start": {
    template: "tanstack-start",
    docsUrl: "https://clerk.com/docs/tanstack-start/getting-started/quickstart",
  },
  astro: { template: "astro", docsUrl: "https://clerk.com/docs/astro/getting-started/quickstart" },
  vue: { template: "vue", docsUrl: "https://clerk.com/docs/vue/getting-started/quickstart" },
  expo: { template: "expo", docsUrl: "https://clerk.com/docs/expo/getting-started/quickstart" },
  express: {
    template: "express",
    docsUrl: "https://clerk.com/docs/express/getting-started/quickstart",
  },
  fastify: {
    template: "fastify",
    docsUrl: "https://clerk.com/docs/fastify/getting-started/quickstart",
  },
};

const DEFAULT_DOCS_URL = "https://clerk.com/docs";

// ---------------------------------------------------------------------------
// Variable builders
// ---------------------------------------------------------------------------

// NOTE: The agent prompts show simple `clerkMiddleware()` (matching official docs).
// The scaffold code in `frameworks/helpers.ts` uses `createRouteMatcher` + `auth.protect()`
// which is more opinionated. This divergence is intentional — agents should follow the
// docs pattern; scaffolded code provides a production-ready starting point.

function buildVars(
  ctx: ProjectContext,
  base: string,
  ext: string,
  jsx: string,
): Record<string, string> {
  const installCmd = `${pmInstallCommand(ctx.packageManager)} ${ctx.framework.sdk}`;

  const vars: Record<string, string> = {
    SDK: ctx.framework.sdk,
    ENV_VAR: ctx.framework.envVar,
    INSTALL_CMD: installCmd,
    BASE: base,
    BASE_DISPLAY: base || "project root",
    EXT: ext,
    JSX: jsx,
    MIDDLEWARE_BASENAME: ctx.middlewareBasename,
    LAYOUT_PATH: ctx.layoutPath ?? `${base}app/layout.${jsx}`,
    ENV_FILE: ctx.envFile,
    PM: ctx.packageManager,
    DOCS_URL: FRAMEWORK_PROMPTS[ctx.framework.dep]?.docsUrl ?? DEFAULT_DOCS_URL,
    FRAMEWORK_NAME: ctx.framework.name,
  };

  if (ctx.framework.dep === "expo") {
    vars.INSTALL_CMD_EXTRA = `${pmInstallCommand(ctx.packageManager)} expo-secure-store`;
  }

  return vars;
}

function resolveTemplate(ctx: ProjectContext): string {
  if (ctx.framework.dep === "next" && ctx.variant === "pages-router") {
    return "nextjs-pages-router";
  }
  return FRAMEWORK_PROMPTS[ctx.framework.dep]?.template ?? "generic-fallback";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const GENERIC_AGENT_PROMPT = loadTemplate("generic");

export function buildAgentPrompt(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "ts" : "js";
  const jsx = ctx.typescript ? "tsx" : "jsx";

  return interpolate(loadTemplate(resolveTemplate(ctx)), buildVars(ctx, base, ext, jsx));
}
