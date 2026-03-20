import { join } from "node:path";
import { parseModule } from "magicast";
import type { FileAction, ProjectContext } from "./types.js";

export type AuthKind = "sign-in" | "sign-up";
type AuthSurface = "page" | "route";

/** Clerk SDK packages that export JSX auth components (SignIn, SignUp). */
type JsxClerkPackage = "@clerk/nextjs" | "@clerk/react-router";
type AuthFileSpec = {
  path: string;
  content: string;
  kind: AuthKind;
  surface: AuthSurface;
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

/** Check if file content already imports from a @clerk/ package. */
export function hasClerkImport(content: string): boolean {
  return content.includes("@clerk/");
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

/** Find the first existing file from a list of candidates relative to cwd. */
export async function findFirstFile(cwd: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await Bun.file(join(cwd, candidate)).exists()) return candidate;
  }
  return null;
}

/**
 * Add an import to a file using magicast AST, with a string-prepend fallback.
 * Returns the modified source code.
 */
export function safeAddImport(content: string, source: string, imported: string): string {
  try {
    const mod = parseModule(content);
    mod.imports.$add({ from: source, imported, local: imported });
    return mod.generate().code;
  } catch {
    return `import { ${imported} } from "${source}";\n${content}`;
  }
}

/** Insert a snippet after the last import statement in a source file. */
export function insertAfterLastImport(source: string, snippet: string): string {
  const lastImportIdx = source.lastIndexOf("import ");
  const lineEnd = source.indexOf("\n", lastImportIdx);
  if (lineEnd === -1) return source;
  return source.slice(0, lineEnd + 1) + snippet + source.slice(lineEnd + 1);
}

/** Wrap the contents of a `<body>` tag with a provider component (e.g. `<ClerkProvider>`). */
export function wrapBodyWithProvider(content: string, provider: string): string {
  let result = content.replace(/(<body[^>]*>)(\s*)/, `$1$2<${provider}>\n`);
  result = result.replace(/(\s*)(<\/body>)/, `\n</${provider}>$1$2`);
  return result;
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

/** Next.js clerkMiddleware with route protection and matcher config. */
export function nextjsMiddlewareContent(): string {
  return `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

${nextjsPublicRouteMatcher()}

${nextjsMiddlewareHandler()}

${nextjsMiddlewareConfig()}
`;
}

function nextjsPublicRouteMatcher(): string {
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
export function jsxAuthPageContent(kind: AuthKind, clerkPackage: JsxClerkPackage): string {
  const component = authComponentName(kind);
  const pageName = component === "SignIn" ? "SignInPage" : "SignUpPage";

  return `import { ${component} } from "${clerkPackage}";

export default function ${pageName}() {
  return <${component} />;
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
    return existing.replace(functionExportPattern, "async function existingMiddleware");
  }

  const arrowExportPattern = /export\s+default\s+(?:async\s+)?(\([^)]*\)\s*=>)/;
  if (arrowExportPattern.test(existing)) {
    return existing.replace(arrowExportPattern, "const existingMiddleware = async $1");
  }

  return null;
}

function hasMiddlewareConfigExport(existing: string): boolean {
  return /export\s+const\s+config\s*=/.test(existing);
}

export function composeWithExistingMiddleware(existing: string): string | null {
  const clerkImport = `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";\n`;
  const routeMatcher = `\n${nextjsPublicRouteMatcher()}\n`;
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
    `\n${nextjsMiddlewareHandler("existingMiddleware(request)")}\n\n${nextjsMiddlewareConfig()}\n`
  );
}

/**
 * Scaffold Next.js middleware — shared between App Router and Pages Router.
 * Checks for existing middleware and returns skip/create/compose action accordingly.
 * When existing non-Clerk middleware is found, it composes rather than overwriting.
 */
export async function scaffoldNextjsMiddleware(ctx: {
  cwd: string;
  srcDir: boolean;
  typescript: boolean;
  deps?: Record<string, string>;
  middlewareBasename?: "proxy" | "middleware";
}): Promise<FileAction> {
  const base = srcPrefix(ctx);
  const ext = scriptExt(ctx);
  const basename = ctx.middlewareBasename ?? resolveNextjsMiddlewareBasename(ctx.deps?.["next"]);
  const path = `${base}${basename}.${ext}`;
  const file = Bun.file(join(ctx.cwd, path));

  if (!(await file.exists())) {
    return {
      path,
      type: "create",
      content: nextjsMiddlewareContent(),
      description: "Create Clerk middleware with route protection",
    };
  }

  const content = await file.text();

  if (hasClerkImport(content)) {
    return { type: "skip", path, skipReason: "Already has Clerk middleware" };
  }

  const composedContent = composeWithExistingMiddleware(content);
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
    description: "Add clerkMiddleware to existing middleware",
  };
}

/** Shared post-instruction for Next.js sign-in/sign-up env vars. Used by both App and Pages Router. */
export const NEXTJS_SIGN_ROUTES_INSTRUCTION =
  "Add to your .env.local: NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in, NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up, NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/, NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/";

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
