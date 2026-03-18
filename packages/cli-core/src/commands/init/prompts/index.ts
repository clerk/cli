import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../frameworks/types.js";

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

const PROMPTS_DIR = import.meta.dir;

const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
  const cached = templateCache.get(name);
  if (cached) return cached;

  // The project formatter escapes underscores in markdown headings (e.g. `_app` → `\_app`).
  // These templates are output as plain text, so undo that escaping.
  const template = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf-8").replaceAll("\\_", "_");
  templateCache.set(name, template);
  return template;
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
