import { join } from "node:path";
import { parseModule } from "magicast";
import {
  addBootstrapHeader,
  authFileSpecs,
  findFirstDirMatch,
  findFirstFile,
  hasTailwindStyles,
  insertAfterLastImport,
  jsxAuthPageContent,
  jsxExt,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldConfigFile,
  scaffoldEnvVars,
  SIGN_ROUTE_ENV_VARS,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

type RootScaffoldResult = {
  action: FileAction | null;
  needsManualLoaderMerge: boolean;
};

type RoutesScaffoldResult = {
  action: FileAction | null;
  /** True when the routes file exists but couldn't be parsed — user must wire manually. */
  needsManualRouteWire: boolean;
};

function addServerImport(source: string, imported: "clerkMiddleware" | "rootAuthLoader"): string {
  if (source.includes(imported)) return source;
  return safeAddImport(source, "@clerk/react-router/server", imported);
}

function addServerImports(source: string, includeRootAuthLoader: boolean): string {
  const withMiddleware = addServerImport(source, "clerkMiddleware");
  return includeRootAuthLoader ? addServerImport(withMiddleware, "rootAuthLoader") : withMiddleware;
}

function addClientImport(source: string, imported: string): string {
  if (source.includes(imported)) return source;
  return safeAddImport(source, "react-router", imported);
}

function hasLoaderExport(source: string): boolean {
  return source.includes("export const loader");
}

function addMiddlewareExport(source: string): string {
  if (source.includes("export const middleware")) return source;
  return insertAfterLastImport(source, "\nexport const middleware = [clerkMiddleware()];\n");
}

function addLoaderExport(source: string, typescript: boolean): string {
  if (hasLoaderExport(source)) return source;

  const middlewareIdx = source.indexOf("export const middleware");
  if (middlewareIdx === -1) return source;

  const lineEnd = source.indexOf("\n", middlewareIdx);
  if (lineEnd === -1) return source;

  const argsParam = typescript ? "(args: Parameters<typeof rootAuthLoader>[0])" : "(args)";
  return (
    source.slice(0, lineEnd + 1) +
    `\nexport const loader = ${argsParam} => rootAuthLoader(args);\n` +
    source.slice(lineEnd + 1)
  );
}

function addLoaderDataBinding(source: string): { content: string; hasLoaderData: boolean } {
  if (source.includes("loaderData }: Route.ComponentProps")) {
    return { content: source, hasLoaderData: true };
  }

  if (source.includes("const loaderData = useLoaderData<typeof loader>()")) {
    return { content: source, hasLoaderData: true };
  }

  const withImport = addClientImport(source, "useLoaderData");
  const updated = withImport.replace(
    /(export\s+default\s+function\s+\w+\([^)]*\)\s*\{)/,
    "$1\n  const loaderData = useLoaderData<typeof loader>();",
  );

  return {
    content: updated,
    hasLoaderData: updated !== withImport,
  };
}

function describeRootAction(options: {
  hasLoaderData: boolean;
  needsManualLoaderMerge: boolean;
  isBootstrap: boolean;
}): string {
  const suffix = options.isBootstrap ? ", and auth header" : "";

  if (options.needsManualLoaderMerge) {
    return `Add ClerkProvider and clerkMiddleware (manual rootAuthLoader merge still required)${suffix}`;
  }

  if (options.hasLoaderData) {
    return `Add ClerkProvider, clerkMiddleware, rootAuthLoader, and loaderData wiring${suffix}`;
  }

  return `Add ClerkProvider, clerkMiddleware, and rootAuthLoader (manual loaderData wiring may be needed)${suffix}`;
}

function wrapOutletWithProvider(source: string, hasLoaderData: boolean): string {
  if (!source.includes("<Outlet") || source.includes("<ClerkProvider")) return source;

  const providerProps = hasLoaderData ? " loaderData={loaderData}" : "";
  return source.replace(
    /(<Outlet\s*\/>)/,
    `<ClerkProvider${providerProps}>\n        $1\n      </ClerkProvider>`,
  );
}

/**
 * Detect an i18n optional locale segment in existing React Router route files.
 * React Router uses `($locale).` or `($lang).` prefix for optional locale params.
 */
function matchLocalePrefix(entry: string): string | null {
  const match = entry.match(/^(\(\$(?:locale|lang)\))\./);
  return match?.[1] ?? null;
}

async function detectLocalePrefix(cwd: string): Promise<string | null> {
  return findFirstDirMatch(cwd, "app/routes", matchLocalePrefix);
}

function authRoutePath(
  ctx: ProjectContext,
  kind: "sign-in" | "sign-up",
  localePrefix: string | null,
): string {
  const prefix = localePrefix ? `${localePrefix}.` : "";
  return `app/routes/${prefix}${kind}.${jsxExt(ctx)}`;
}

async function scaffoldAuthRoutes(
  ctx: ProjectContext,
  localePrefix: string | null,
): Promise<FileAction[]> {
  const tailwind = hasTailwindStyles(ctx);
  return scaffoldAuthFiles(
    ctx.cwd,
    authFileSpecs({
      path: (kind) => authRoutePath(ctx, kind, localePrefix),
      content: (kind) => jsxAuthPageContent(kind, "@clerk/react-router", tailwind),
      surface: "route",
    }),
  );
}

async function scaffoldRoot(ctx: ProjectContext): Promise<RootScaffoldResult> {
  const rootPath = await findFirstFile(ctx.cwd, ["app/root.tsx", "app/root.jsx"]);
  if (!rootPath) {
    return { action: null, needsManualLoaderMerge: false };
  }

  const content = await Bun.file(join(ctx.cwd, rootPath)).text();

  if (content.includes("ClerkProvider")) {
    return {
      action: { type: "skip", path: rootPath, skipReason: "Already has ClerkProvider" },
      needsManualLoaderMerge: false,
    };
  }

  const hasExistingLoader = hasLoaderExport(content);
  const needsManualLoaderMerge = hasExistingLoader && !content.includes("rootAuthLoader");

  let result = addServerImports(content, !needsManualLoaderMerge);
  result = safeAddImport(result, "@clerk/react-router", "ClerkProvider");
  result = addMiddlewareExport(result);
  result = hasExistingLoader ? result : addLoaderExport(result, ctx.typescript);
  const loaderDataResult = needsManualLoaderMerge
    ? { content: result, hasLoaderData: false }
    : addLoaderDataBinding(result);
  result = wrapOutletWithProvider(loaderDataResult.content, loaderDataResult.hasLoaderData);

  if (ctx.isBootstrap) {
    result = addBootstrapHeader(result, "@clerk/react-router", hasTailwindStyles(ctx));
  }

  return {
    action: {
      path: rootPath,
      type: "modify",
      content: result,
      description: describeRootAction({
        hasLoaderData: loaderDataResult.hasLoaderData,
        needsManualLoaderMerge,
        isBootstrap: Boolean(ctx.isBootstrap),
      }),
    },
    needsManualLoaderMerge,
  };
}

/**
 * Enable the `future.v8_middleware` flag in react-router.config.
 * React Router v7 requires this opt-in flag to activate the middleware API
 * that clerkMiddleware() depends on. It becomes the default in v8.
 */
function enableV8Middleware(content: string): string {
  try {
    const mod = parseModule(content);
    const defaultExport = mod.exports.default;
    if (!defaultExport || typeof defaultExport !== "object") return content;

    if (!defaultExport.future) defaultExport.future = {};
    defaultExport.future.v8_middleware = true;
    return mod.generate().code;
  } catch {
    if (content.includes("future:")) {
      return content.replace(/(future:\s*\{)/, "$1\n    v8_middleware: true,");
    }
    return content.replace(
      /(}\s*satisfies\s*Config)/,
      "  future: {\n    v8_middleware: true,\n  },\n$1",
    );
  }
}

/**
 * Ensure `route` is included in the import from `@react-router/dev/routes`.
 * Handles the common pattern: `import { ..., index } from "@react-router/dev/routes"`.
 */
function ensureRouteImported(source: string): string {
  // Check whether `route` is already a named import from the routes package.
  const importMatch = source.match(
    /import\s*\{([^}]*)\}\s*from\s*["']@react-router\/dev\/routes["']/,
  );
  const importedNames = importMatch?.[1];
  if (!importedNames || /\broute\b/.test(importedNames)) return source;

  return source.replace(
    /(\bimport\s*\{[^}]*)(\}\s*from\s*["']@react-router\/dev\/routes["'])/,
    (_, imports, rest) => `${imports.trimEnd()}, route${rest}`,
  );
}

/**
 * Build the two route() call strings for sign-in and sign-up,
 * accounting for an optional locale prefix and the project's JS/TS extension.
 */
function buildRouteEntries(
  ctx: ProjectContext,
  localePrefix: string | null,
): { signIn: string; signUp: string } {
  const ext = jsxExt(ctx);
  const prefix = localePrefix ? `${localePrefix}/` : "";
  const signInFile = localePrefix
    ? `routes/${localePrefix}.sign-in.${ext}`
    : `routes/sign-in.${ext}`;
  const signUpFile = localePrefix
    ? `routes/${localePrefix}.sign-up.${ext}`
    : `routes/sign-up.${ext}`;

  return {
    signIn: `route("${prefix}sign-in/*", "${signInFile}")`,
    signUp: `route("${prefix}sign-up/*", "${signUpFile}")`,
  };
}

/**
 * Check whether a route() call for the given URL path already exists in source.
 * Matches any quote style and is file-extension-agnostic.
 */
function hasRouteForPath(source: string, urlPath: string): boolean {
  const escaped = urlPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`route\\s*\\(\\s*["'\`]${escaped}["'\`]`).test(source);
}

/**
 * Inject sign-in/sign-up route() calls into `app/routes.ts`.
 *
 * Only injects routes that are not already present (checked by URL path,
 * not by file reference — so the check is extension-agnostic and idempotent).
 *
 * Strategy (in order):
 *  1. Try to find the canonical `export default [...] satisfies RouteConfig` pattern
 *     and append entries inside the array literal.
 *  2. If not found, attempt a simpler append before the closing `]` of any default export array.
 *  3. Return null (unmodified) when neither strategy can safely apply.
 */
function injectRouteEntries(
  source: string,
  ctx: ProjectContext,
  localePrefix: string | null,
): string | null {
  const prefix = localePrefix ? `${localePrefix}/` : "";
  const signInPath = `${prefix}sign-in/*`;
  const signUpPath = `${prefix}sign-up/*`;

  const hasSignIn = hasRouteForPath(source, signInPath);
  const hasSignUp = hasRouteForPath(source, signUpPath);

  if (hasSignIn && hasSignUp) return source;

  const { signIn, signUp } = buildRouteEntries(ctx, localePrefix);
  const missing = [!hasSignIn && signIn, !hasSignUp && signUp].filter(
    (e): e is string => e !== false,
  );
  const newEntries = missing.join(",\n  ");

  // Strategy 1: canonical create-react-router pattern.
  const canonicalPattern = /export default \[([^\]]*)\]\s*satisfies\s*RouteConfig\s*;/s;
  const canonical = source.match(canonicalPattern);
  if (canonical) {
    const innerContent = (canonical[1] ?? "").trimEnd();
    const separator = innerContent.length > 0 && !innerContent.endsWith(",") ? "," : "";
    const newInner = `${innerContent}${separator}\n  ${newEntries},\n`;
    return source.replace(canonicalPattern, `export default [${newInner}] satisfies RouteConfig;`);
  }

  // Strategy 2: any `export default [...]` array (no satisfies).
  const simplePattern = /(export\s+default\s+\[)([\s\S]*?)(\]\s*;)/;
  const simple = source.match(simplePattern);
  if (simple) {
    const innerContent = (simple[2] ?? "").trimEnd();
    const separator = innerContent.length > 0 && !innerContent.endsWith(",") ? "," : "";
    const newInner = `${innerContent}${separator}\n  ${newEntries},\n`;
    return source.replace(simplePattern, `$1${newInner}$3`);
  }

  return null;
}

async function scaffoldRoutes(
  ctx: ProjectContext,
  localePrefix: string | null,
): Promise<RoutesScaffoldResult> {
  const routesPath = await findFirstFile(ctx.cwd, ["app/routes.ts", "app/routes.js"]);
  if (!routesPath) return { action: null, needsManualRouteWire: false };

  const content = await Bun.file(join(ctx.cwd, routesPath)).text();

  const updated = injectRouteEntries(content, ctx, localePrefix);
  if (updated === null) {
    return { action: null, needsManualRouteWire: true };
  }

  if (updated === content) {
    return {
      action: { type: "skip", path: routesPath, skipReason: "Routes already wired" },
      needsManualRouteWire: false,
    };
  }

  const withImport = ensureRouteImported(updated);
  return {
    action: {
      path: routesPath,
      type: "modify",
      content: withImport,
      description: "Wire sign-in and sign-up routes into app/routes.ts",
    },
    needsManualRouteWire: false,
  };
}

function scaffoldConfig(ctx: ProjectContext): Promise<FileAction | null> {
  return scaffoldConfigFile(ctx.cwd, {
    candidates: ["react-router.config.ts", "react-router.config.js"],
    existsCheck: "v8_middleware",
    modify: enableV8Middleware,
    description: "Enable v8_middleware future flag for Clerk middleware",
    existingSkipReason: "Already has v8_middleware flag",
    missingAction: null,
  });
}

export const reactRouter: FrameworkScaffold = {
  name: "React Router",
  dep: "react-router",
  minMajorVersion: 7,

  matches: (ctx) => ctx.framework.dep === "react-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [configAction, rootResult, localePrefix, envAction] = await Promise.all([
      scaffoldConfig(ctx),
      scaffoldRoot(ctx),
      detectLocalePrefix(ctx.cwd),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.vite),
    ]);
    const [authActions, routesResult] = await Promise.all([
      scaffoldAuthRoutes(ctx, localePrefix),
      scaffoldRoutes(ctx, localePrefix),
    ]);

    const rootAction = rootResult.action;
    const actions = [
      configAction,
      rootAction,
      ...authActions,
      routesResult.action,
      envAction,
    ].filter((action): action is FileAction => action !== null);
    const postInstructions: string[] = [];

    if (!rootAction) {
      postInstructions.push(
        "Add ClerkProvider, clerkMiddleware(), and rootAuthLoader() to your app/root.tsx. See: https://clerk.com/docs/react-router/getting-started/quickstart",
      );
    }

    if (routesResult.needsManualRouteWire) {
      const ext = jsxExt(ctx);
      postInstructions.push(
        `Add sign-in and sign-up routes to app/routes.ts: route('sign-in/*', 'routes/sign-in.${ext}') and route('sign-up/*', 'routes/sign-up.${ext}')`,
      );
    }

    if (rootAction?.type === "modify" && rootResult.needsManualLoaderMerge) {
      postInstructions.push(
        "Update your existing app/root.tsx loader to import and call rootAuthLoader(args), then pass that loaderData to <ClerkProvider>.",
      );
    }

    return { actions, postInstructions };
  },
};
