import { join } from "node:path";
import { parseModule } from "magicast";
import type { FileAction } from "./types.js";

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

  const hasDefaultExport = /export\s+default\s+/.test(existing);

  if (hasDefaultExport) {
    let content = existing.replace(
      /export\s+default\s+(?:async\s+)?function\s+(\w+)?/,
      "async function existingMiddleware",
    );
    content = content.replace(
      /export\s+default\s+(?:async\s+)?(\([^)]*\)\s*=>)/,
      "const existingMiddleware = async $1",
    );

    return (
      clerkImport +
      routeMatcher +
      "\n" +
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

  return clerkImport + routeMatcher + "\n" + existing + "\n" + nextjsMiddlewareContent();
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
  middlewareBasename: "proxy" | "middleware";
}): Promise<FileAction> {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "ts" : "js";
  const path = `${base}${ctx.middlewareBasename}.${ext}`;
  const fullPath = join(ctx.cwd, path);

  const file = Bun.file(fullPath);
  if (await file.exists()) {
    const content = await file.text();
    if (hasClerkImport(content)) {
      return {
        path,
        type: "modify",
        content: "",
        description: "Create Clerk middleware",
        skipReason: "Already has Clerk middleware",
      };
    }

    return {
      path,
      type: "modify",
      content: composeWithExistingMiddleware(content),
      description: "Add clerkMiddleware to existing middleware",
    };
  }

  return {
    path,
    type: "create",
    content: nextjsMiddlewareContent(),
    description: "Create Clerk middleware with route protection",
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
    return {
      path,
      type: "create",
      content: "",
      description: `Create ${label}`,
      skipReason: `${capitalizedLabel} already exists`,
    };
  }

  const component = label.includes("sign-in") ? "SignIn" : "SignUp";
  return {
    path,
    type: "create",
    content,
    description: `Create ${label} with <${component} /> component`,
  };
}
