import { join } from "node:path";
import { parseModule } from "magicast";
import type { FileAction } from "./types.js";

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

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
`;
}

/** Next.js sign-in page component. */
export function nextjsSignInPageContent(): string {
  return `import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return <SignIn />;
}
`;
}

/** Next.js sign-up page component. */
export function nextjsSignUpPageContent(): string {
  return `import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return <SignUp />;
}
`;
}

/**
 * Compose Clerk middleware with existing non-Clerk middleware.
 * Renames the existing default export and wraps it inside clerkMiddleware.
 */
export function composeWithExistingMiddleware(existing: string): string {
  const clerkImport = `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";\n`;
  const routeMatcher = `\nconst isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);\n`;
  const preamble = clerkImport + routeMatcher + "\n";

  if (!/export\s+default\s+/.test(existing)) {
    return preamble + existing + "\n" + nextjsMiddlewareContent();
  }

  let content = existing.replace(
    /export\s+default\s+(?:async\s+)?function\s+(\w+)?/,
    "async function existingMiddleware",
  );
  content = content.replace(
    /export\s+default\s+(?:async\s+)?(\([^)]*\)\s*=>)/,
    "const existingMiddleware = async $1",
  );

  return (
    preamble +
    content +
    `\nexport default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
  return existingMiddleware(request);
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
`
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
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "ts" : "js";
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

  return {
    path,
    type: "modify",
    content: composeWithExistingMiddleware(content),
    description: "Add clerkMiddleware to existing middleware",
  };
}

/** Shared post-instruction for Next.js sign-in/sign-up env vars. Used by both App and Pages Router. */
export const NEXTJS_SIGN_ROUTES_INSTRUCTION =
  "Add to your .env.local: NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in, NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up, NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/, NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generic helper for scaffolding an auth page (sign-in or sign-up).
 * Handles the common create-or-skip pattern used by every framework scaffolder.
 */
export async function scaffoldAuthPage(
  cwd: string,
  path: string,
  content: string,
  label: string,
): Promise<FileAction> {
  const capitalizedLabel = capitalize(label);

  if (await Bun.file(join(cwd, path)).exists()) {
    return { type: "skip", path, skipReason: `${capitalizedLabel} already exists` };
  }

  const component = label.includes("sign-in") ? "SignIn" : "SignUp";
  return {
    path,
    type: "create",
    content,
    description: `Create ${label} with <${component} /> component`,
  };
}
