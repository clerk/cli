import { join } from "node:path";
import { parseModule } from "magicast";
import {
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
}): string {
  if (options.needsManualLoaderMerge) {
    return "Add ClerkProvider and clerkMiddleware (manual rootAuthLoader merge still required)";
  }

  if (options.hasLoaderData) {
    return "Add ClerkProvider, clerkMiddleware, rootAuthLoader, and loaderData wiring";
  }

  return "Add ClerkProvider, clerkMiddleware, and rootAuthLoader (manual loaderData wiring may be needed)";
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

  return {
    action: {
      path: rootPath,
      type: "modify",
      content: result,
      description: describeRootAction({
        hasLoaderData: loaderDataResult.hasLoaderData,
        needsManualLoaderMerge,
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
    const authActions = await scaffoldAuthRoutes(ctx, localePrefix);

    const rootAction = rootResult.action;
    const actions = [configAction, rootAction, ...authActions, envAction].filter(
      (action): action is FileAction => action !== null,
    );
    const postInstructions: string[] = [];

    if (rootAction) {
      postInstructions.push(
        "Add sign-in and sign-up routes to app/routes.ts: route('sign-in/*', 'routes/sign-in.tsx') and route('sign-up/*', 'routes/sign-up.tsx')",
      );
    } else {
      postInstructions.push(
        "Add ClerkProvider, clerkMiddleware(), and rootAuthLoader() to your app/root.tsx. See: https://clerk.com/docs/quickstarts/react-router",
      );
      postInstructions.push(
        "Add sign-in and sign-up routes to app/routes.ts: route('sign-in/*', 'routes/sign-in.tsx') and route('sign-up/*', 'routes/sign-up.tsx')",
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
