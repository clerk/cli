/**
 * Shared helpers used by both framework scaffolders (app code) and their tests.
 * Contains utilities for file detection, scaffolding patterns (auth pages, config files,
 * env vars, middleware), and re-exports text transformations from `transformations.ts`.
 */
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { parseEnvFile, mergeEnvVars, serializeEnvFile } from "../../../lib/dotenv.js";
import type { FileAction, ProjectContext } from "./types.js";
import { hasClerkImport, indentBlock } from "./transformations.js";

// Re-export text transformations so existing imports from helpers.ts keep working.
export {
  hasClerkImport,
  indentBlock,
  safeAddImport,
  insertAfterLastImport,
  wrapBodyWithProvider,
  injectHeaderInProvider,
} from "./transformations.js";

export type AuthKind = "sign-in" | "sign-up";
type AuthSurface = "page" | "route";
const AUTH_KINDS = ["sign-in", "sign-up"] as const satisfies readonly AuthKind[];

/** Clerk SDK packages that export JSX auth components (SignIn, SignUp). */
type JsxClerkPackage = "@clerk/nextjs" | "@clerk/react-router";
type AuthFileSpec = {
  path: string;
  content: string;
  kind: AuthKind;
  surface: AuthSurface;
};
type AuthWrapperMarkup = {
  tailwind: string;
  plain: string;
};

const HTML_AUTH_WRAPPER: AuthWrapperMarkup = {
  tailwind: `<div class="flex min-h-screen items-center justify-center">`,
  plain: `<div style="display:flex;min-height:100vh;align-items:center;justify-content:center">`,
};

const JSX_AUTH_WRAPPER: AuthWrapperMarkup = {
  tailwind: `<div className="flex min-h-screen items-center justify-center">`,
  plain: `<div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>`,
};

/**
 * Parse the major version from a semver-like string.
 * Handles: "15.0.0", "^15.0.0", "~15.0.0", ">=15", etc.
 * Returns null for non-numeric versions like "latest", "canary", "*".
 */
export function parseMajorVersion(version: string): number | null {
  const match = version.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

export function srcPrefix(ctx: Pick<ProjectContext, "srcDir">): string {
  return ctx.srcDir ? "src/" : "";
}

export function scriptExt(ctx: Pick<ProjectContext, "typescript">): "ts" | "js" {
  return ctx.typescript ? "ts" : "js";
}

export function jsxExt(ctx: Pick<ProjectContext, "typescript">): "tsx" | "jsx" {
  return ctx.typescript ? "tsx" : "jsx";
}

export function hasTailwindStyles(ctx: Pick<ProjectContext, "deps">): boolean {
  return Boolean(ctx.deps["tailwindcss"]);
}

function authWrapper(markup: AuthWrapperMarkup, tailwind: boolean): string {
  if (tailwind) return markup.tailwind;
  return markup.plain;
}

function renderCenteredAuthComponent(
  component: string,
  markup: AuthWrapperMarkup,
  tailwind: boolean,
): string {
  const wrapper = authWrapper(markup, tailwind);
  return `${wrapper}
  <${component} />
</div>`;
}

export function htmlAuthComponentMarkup(component: string, tailwind: boolean): string {
  return renderCenteredAuthComponent(component, HTML_AUTH_WRAPPER, tailwind);
}

export function jsxAuthComponentMarkup(component: string, tailwind: boolean): string {
  return renderCenteredAuthComponent(component, JSX_AUTH_WRAPPER, tailwind);
}

function buildAuthFileSpec(
  kind: AuthKind,
  options: {
    path: (kind: AuthKind) => string;
    content: (kind: AuthKind) => string;
    surface: AuthSurface;
  },
): AuthFileSpec {
  return {
    path: options.path(kind),
    content: options.content(kind),
    kind,
    surface: options.surface,
  };
}

export function authFileSpecs(options: {
  path: (kind: AuthKind) => string;
  content: (kind: AuthKind) => string;
  surface: AuthSurface;
}): readonly AuthFileSpec[] {
  return AUTH_KINDS.map((kind) => buildAuthFileSpec(kind, options));
}

/** Find the first existing file from a list of candidates relative to cwd. */
export async function findFirstFile(cwd: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await Bun.file(join(cwd, candidate)).exists()) return candidate;
  }
  return null;
}

export async function findFirstDirMatch<T>(
  cwd: string,
  dir: string,
  matcher: (entry: string) => T | null,
): Promise<T | null> {
  try {
    const entries = await readdir(join(cwd, dir));
    for (const entry of entries) {
      const match = matcher(entry);
      if (match !== null) return match;
    }
  } catch {
    return null;
  }

  return null;
}

/** Resolve the middleware basename from a Next.js version string. >=16 uses proxy, <=15 uses middleware. */
export function resolveNextjsMiddlewareBasename(
  nextVersion: string | undefined,
): "proxy" | "middleware" {
  if (!nextVersion) return "proxy";
  const major = parseMajorVersion(nextVersion);
  if (major === null) return "proxy";
  return major >= 16 ? "proxy" : "middleware";
}

// ─── i18n Middleware Library Detection ────────────────────────────

/**
 * Known Next.js i18n libraries that use middleware.
 * Listed in priority order — the first match in deps wins.
 *
 * Libraries from https://nextjs.org/docs/app/guides/internationalization:
 * next-intl, next-international, next-i18n-router, paraglide-next, next-intlayer
 */
type I18nMiddlewareLib = {
  dep: string;
  importFrom: string;
  varName: string;
};

const I18N_MIDDLEWARE_LIBS: readonly I18nMiddlewareLib[] = [
  { dep: "next-intl", importFrom: "next-intl/middleware", varName: "intlMiddleware" },
  {
    dep: "next-international",
    importFrom: "next-international/middleware",
    varName: "i18nMiddleware",
  },
  { dep: "next-i18n-router", importFrom: "next-i18n-router", varName: "i18nMiddleware" },
  {
    dep: "@inlang/paraglide-next",
    importFrom: "@inlang/paraglide-next",
    varName: "paraglideMiddleware",
  },
  { dep: "next-intlayer", importFrom: "next-intlayer/middleware", varName: "intlayerMiddleware" },
];

/** Detect which i18n middleware library is used based on project dependencies. */
function detectI18nMiddlewareLib(deps: Record<string, string>): I18nMiddlewareLib | null {
  return I18N_MIDDLEWARE_LIBS.find((lib) => deps[lib.dep]) ?? null;
}

/** Check if middleware content imports from a known i18n middleware package. */
function detectI18nMiddlewareImport(content: string): I18nMiddlewareLib | null {
  return I18N_MIDDLEWARE_LIBS.find((lib) => content.includes(lib.importFrom)) ?? null;
}

// ─── Middleware Content Generation ────────────────────────────────

/** Next.js clerkMiddleware — permissive (unauthenticated) or protective (default). */
export function nextjsMiddlewareContent(keyless = false): string {
  if (keyless) {
    return `import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

${nextjsMiddlewareConfig()}
`;
  }
  return `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

${nextjsPublicRouteMatcher()}

${nextjsMiddlewareHandler()}

${nextjsMiddlewareConfig()}
`;
}

/**
 * Generate composed Clerk + i18n middleware content.
 * When routingImport is provided (e.g., next-intl routing config found),
 * the middleware is fully configured. Otherwise, a placeholder setup is generated.
 */
function nextjsI18nMiddlewareContent(lib: I18nMiddlewareLib, routingImport: string | null): string {
  const i18nImport = routingImport
    ? `import createMiddleware from "${lib.importFrom}";\n${routingImport}`
    : `import createMiddleware from "${lib.importFrom}";`;

  const setup = routingImport
    ? `const ${lib.varName} = createMiddleware(routing);`
    : `const ${lib.varName} = createMiddleware({\n  locales: ["en"],\n  defaultLocale: "en",\n});`;

  return `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
${i18nImport}

${setup}

${nextjsPublicRouteMatcher(true)}

${nextjsMiddlewareHandler(`${lib.varName}(request)`)}

${nextjsMiddlewareConfig()}
`;
}

function nextjsPublicRouteMatcher(i18n = false): string {
  if (i18n) {
    return `const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/:locale/sign-in(.*)",
  "/:locale/sign-up(.*)",
]);`;
  }
  return `const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);`;
}

function nextjsMiddlewareHandler(returnStatement = ""): string {
  const returnLine = returnStatement ? `\n  return ${returnStatement};` : "";

  return `export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }${returnLine}
});`;
}

function nextjsMiddlewareConfig(): string {
  return `export const config = {
  matcher: [
    "/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};`;
}

export function authComponentName(kind: AuthKind): "SignIn" | "SignUp" {
  return kind === "sign-in" ? "SignIn" : "SignUp";
}

/** Generate a JSX auth page component for a Clerk framework SDK that exports SignIn/SignUp. */
export function jsxAuthPageContent(
  kind: AuthKind,
  clerkPackage: JsxClerkPackage,
  tailwind: boolean,
): string {
  const component = authComponentName(kind);
  const pageName = component === "SignIn" ? "SignInPage" : "SignUpPage";
  const content = indentBlock(jsxAuthComponentMarkup(component, tailwind), "    ");

  return `import { ${component} } from "${clerkPackage}";

export default function ${pageName}() {
  return (
${content}
  );
}
`;
}

/**
 * Compose Clerk middleware with existing non-Clerk middleware.
 * Renames the existing default export and wraps it inside clerkMiddleware.
 */
function renameDefaultMiddlewareExport(existing: string): string | null {
  const functionExportPattern = /export\s+default\s+(?:async\s+)?function(?:\s+\w+)?/;
  if (functionExportPattern.test(existing)) {
    return existing.replace(functionExportPattern, "async function middleware");
  }

  const arrowExportPattern = /export\s+default\s+(?:async\s+)?(\([^)]*\)\s*=>)/;
  if (arrowExportPattern.test(existing)) {
    return existing.replace(arrowExportPattern, "const middleware = async $1");
  }

  // Expression: export default someIdentifier or export default someCall(...)
  // Catches patterns like `export default wrapped` or `export default createMiddleware(routing)`
  if (/export\s+default\s+/.test(existing)) {
    // If already exporting a variable named `middleware`, just strip the export line
    if (/export\s+default\s+middleware\s*[;\n]/.test(existing)) {
      return existing.replace(/export\s+default\s+middleware\s*;?\s*\n?/, "");
    }
    return existing.replace(/export\s+default\s+/, "const middleware = ");
  }

  return null;
}

function hasMiddlewareConfigExport(existing: string): boolean {
  return /export\s+const\s+config\s*=/.test(existing);
}

export function composeWithExistingMiddleware(existing: string, i18n = false): string | null {
  const clerkImport = `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";\n`;
  const routeMatcher = `\n${nextjsPublicRouteMatcher(i18n)}\n`;
  const preamble = clerkImport + routeMatcher + "\n";

  if (hasMiddlewareConfigExport(existing)) {
    return null;
  }

  if (!/export\s+default\s+/.test(existing)) {
    return `${preamble}${existing}\n${nextjsMiddlewareHandler()}\n\n${nextjsMiddlewareConfig()}\n`;
  }

  const content = renameDefaultMiddlewareExport(existing);
  if (!content) return null;

  return (
    preamble +
    content +
    `\n${nextjsMiddlewareHandler("middleware(request)")}\n\n${nextjsMiddlewareConfig()}\n`
  );
}

/**
 * Compose Clerk middleware with an existing i18n middleware.
 *
 * Only handles the common i18n pattern `export default createMiddleware(...)` —
 * a bare expression export. Function declarations and arrow functions are left
 * to the general-purpose composer (via `composeWithExistingMiddleware`) because
 * they typically represent user-customized middleware that already calls the
 * i18n middleware internally.
 *
 * Also strips the existing `export const config` since Clerk's matcher replaces it.
 */
export function composeWithI18nMiddleware(existing: string): string | null {
  const lib = detectI18nMiddlewareImport(existing);
  if (!lib) return null;

  // Only handle expression exports (e.g., `export default createMiddleware(routing)`).
  // Function declarations / arrow functions are handled by the general-purpose composer.
  if (/export\s+default\s+(?:async\s+)?function/.test(existing)) return null;
  if (/export\s+default\s+(?:async\s+)?\(/.test(existing)) return null;

  // Bail if the varName is already used (would create a duplicate declaration)
  if (existing.includes(`const ${lib.varName}`)) return null;

  const clerkImport = `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";\n`;

  // Strip existing config export (Clerk's matcher replaces it)
  let content = existing.replace(/\n*export\s+const\s+config\s*=[\s\S]*$/, "");

  // Rename `export default <expression>` to `const <varName> = <expression>`
  content = content.replace(/export\s+default\s+/, `const ${lib.varName} = `);

  // Verify the rename succeeded — if export default is still present, bail
  if (/export\s+default\s+/.test(content)) return null;

  return (
    clerkImport +
    content +
    `\n\n${nextjsPublicRouteMatcher(true)}\n\n${nextjsMiddlewareHandler(`${lib.varName}(request)`)}\n\n${nextjsMiddlewareConfig()}\n`
  );
}

/**
 * Find a next-intl routing config file for importing in composed middleware.
 * Returns an import statement like `import { routing } from "./i18n/routing"` or null.
 */
async function findI18nRoutingImport(
  cwd: string,
  srcDir: boolean,
  lib: I18nMiddlewareLib,
): Promise<string | null> {
  if (lib.dep !== "next-intl") return null;

  const base = srcPrefix({ srcDir });
  const hasRoutingFile = await findFirstFile(cwd, [
    `${base}i18n/routing.ts`,
    `${base}i18n/routing.js`,
  ]);

  if (!hasRoutingFile) return null;

  // Middleware and routing are co-located under the same base (root or src/),
  // so the relative import path is always the same regardless of srcDir.
  return `import { routing } from "./i18n/routing";`;
}

/**
 * Scaffold Next.js middleware — shared between App Router and Pages Router.
 * Checks for existing middleware and returns skip/create/compose action accordingly.
 * When existing non-Clerk middleware is found, it composes rather than overwriting.
 * When an i18n library is detected, generates composed Clerk + i18n middleware.
 */
export async function scaffoldNextjsMiddleware(ctx: {
  cwd: string;
  srcDir: boolean;
  typescript: boolean;
  deps?: Record<string, string>;
  middlewareBasename?: "proxy" | "middleware";
  keyless?: boolean;
}): Promise<FileAction> {
  const base = srcPrefix(ctx);
  const ext = scriptExt(ctx);
  const basename = ctx.middlewareBasename ?? resolveNextjsMiddlewareBasename(ctx.deps?.["next"]);
  const path = `${base}${basename}.${ext}`;
  const file = Bun.file(join(ctx.cwd, path));

  if (!(await file.exists())) {
    // Check for i18n library — generate composed middleware if detected
    const i18nLib = detectI18nMiddlewareLib(ctx.deps ?? {});
    if (i18nLib) {
      const routingImport = await findI18nRoutingImport(ctx.cwd, ctx.srcDir, i18nLib);
      return {
        path,
        type: "create",
        content: nextjsI18nMiddlewareContent(i18nLib, routingImport),
        description: `Create Clerk middleware composed with ${i18nLib.dep}`,
      };
    }

    return {
      path,
      type: "create",
      content: nextjsMiddlewareContent(ctx.keyless),
      description: ctx.keyless
        ? "Create Clerk middleware (permissive — connect your account later)"
        : "Create Clerk middleware with route protection",
    };
  }

  const content = await file.text();

  if (hasClerkImport(content)) {
    return { type: "skip", path, skipReason: "Already has Clerk middleware" };
  }

  // Try i18n-specific composition first (handles expression exports like `export default createMiddleware(...)`)
  const i18nComposed = composeWithI18nMiddleware(content);
  if (i18nComposed) {
    return {
      path,
      type: "modify",
      content: i18nComposed,
      description: "Add clerkMiddleware composing with existing i18n middleware",
    };
  }

  // For i18n middleware with function exports (user already composed their own middleware),
  // strip the config export first — Clerk's matcher replaces it — then use the general composer.
  const isI18nMiddleware = detectI18nMiddlewareImport(content) !== null;
  const contentForComposition =
    isI18nMiddleware && hasMiddlewareConfigExport(content)
      ? content.replace(/\n*export\s+const\s+config\s*=[\s\S]*$/, "")
      : content;

  // Fall through to general-purpose composition
  const composedContent = composeWithExistingMiddleware(contentForComposition, isI18nMiddleware);
  if (!composedContent) {
    return {
      type: "skip",
      path,
      skipReason: "Existing middleware uses an unsupported shape for automatic Clerk composition",
    };
  }

  return {
    path,
    type: "modify",
    content: composedContent,
    description: isI18nMiddleware
      ? "Add clerkMiddleware wrapping existing i18n middleware"
      : "Add clerkMiddleware to existing middleware",
  };
}

/**
 * Create a scaffold action that merges env vars into the project's env file.
 * Skips if all vars are already present.
 */
export async function scaffoldEnvVars(
  ctx: ProjectContext,
  vars: Record<string, string>,
): Promise<FileAction> {
  const envPath = join(ctx.cwd, ctx.envFile);
  const file = Bun.file(envPath);
  const existing = (await file.exists()) ? await file.text() : "";

  const lines = parseEnvFile(existing);

  const allPresent = Object.keys(vars).every((key) =>
    lines.some((l) => l.type === "entry" && l.key === key),
  );
  if (allPresent) {
    return {
      type: "skip",
      path: ctx.envFile,
      skipReason: "Sign-in/sign-up route vars already set",
    };
  }

  const merged = mergeEnvVars(lines, vars);
  return {
    path: ctx.envFile,
    type: "modify",
    content: serializeEnvFile(merged),
    description: "Add sign-in/sign-up route env vars",
  };
}

/** Sign-in/sign-up route env vars per framework prefix. */
export const SIGN_ROUTE_ENV_VARS = {
  nextjs: {
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "/",
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "/",
  },
  vite: {
    VITE_CLERK_SIGN_IN_URL: "/sign-in",
    VITE_CLERK_SIGN_UP_URL: "/sign-up",
    VITE_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "/",
    VITE_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "/",
  },
  astro: {
    PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  },
  nuxt: {
    NUXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    NUXT_PUBLIC_CLERK_SIGN_UP_URL: "/sign-up",
  },
} as const;

/**
 * Generic helper for scaffolding a framework config file.
 * Handles the common find → check → modify → return pattern used by Astro, Nuxt, and React Router.
 * The generic preserves the return type: when missingAction is a FileAction, the return is FileAction;
 * when missingAction is null, the return is FileAction | null.
 */
export async function scaffoldConfigFile<TMissing extends FileAction | null>(
  cwd: string,
  options: {
    candidates: string[];
    existsCheck: string;
    modify: (content: string) => string;
    description: string;
    existingSkipReason: string;
    missingAction: TMissing;
  },
): Promise<FileAction | TMissing> {
  const configPath = await findFirstFile(cwd, options.candidates);
  if (!configPath) return options.missingAction;

  const content = await Bun.file(join(cwd, configPath)).text();
  if (content.includes(options.existsCheck)) {
    return { type: "skip", path: configPath, skipReason: options.existingSkipReason };
  }

  return {
    path: configPath,
    type: "modify",
    content: options.modify(content),
    description: options.description,
  };
}

/**
 * Generic helper for scaffolding an auth page (sign-in or sign-up).
 * Handles the common create-or-skip pattern used by every framework scaffolder.
 */
export async function scaffoldAuthFile(
  cwd: string,
  path: string,
  content: string,
  kind: AuthKind,
  surface: AuthSurface,
): Promise<FileAction> {
  const label = `${kind} ${surface}`;
  const capitalizedLabel = `${label[0]!.toUpperCase()}${label.slice(1)}`;

  if (await Bun.file(join(cwd, path)).exists()) {
    return { type: "skip", path, skipReason: `${capitalizedLabel} already exists` };
  }

  const component = authComponentName(kind);
  return {
    path,
    type: "create",
    content,
    description: `Create ${label} with <${component} /> component`,
  };
}

export async function scaffoldAuthFiles(
  cwd: string,
  specs: readonly AuthFileSpec[],
): Promise<FileAction[]> {
  return Promise.all(
    specs.map((spec) => scaffoldAuthFile(cwd, spec.path, spec.content, spec.kind, spec.surface)),
  );
}
