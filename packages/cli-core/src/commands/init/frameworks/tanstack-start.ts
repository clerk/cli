import { join } from "node:path";
import {
  authComponentName,
  authFileSpecs,
  findFirstFile,
  findFirstDirMatch,
  hasTailwindStyles,
  hasClerkImport,
  indentBlock,
  jsxAuthComponentMarkup,
  jsxExt,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldEnvVars,
  SIGN_ROUTE_ENV_VARS,
  wrapBodyWithProvider,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

type TanstackBaseDir = "app" | "src";

const START_FILE_CANDIDATES = [
  "src/start.ts",
  "src/start.tsx",
  "src/start.js",
  "src/start.jsx",
  "app/start.ts",
  "app/start.tsx",
  "app/start.js",
  "app/start.jsx",
] as const;

const ROOT_ROUTE_CANDIDATES = [
  "src/routes/__root.tsx",
  "src/routes/__root.jsx",
  "app/routes/__root.tsx",
  "app/routes/__root.jsx",
] as const;

function authRouteContent(kind: "sign-in" | "sign-up", tailwind: boolean): string {
  const component = authComponentName(kind);
  const content = indentBlock(jsxAuthComponentMarkup(component, tailwind), "    ");

  return `import { ${component} } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/${kind}/$")({
  component: Page,
});

function Page() {
  return (
${content}
  );
}
`;
}

function baseDirFromPath(path: string | null): TanstackBaseDir | null {
  if (!path) return null;
  return path.startsWith("app/") ? "app" : "src";
}

async function findStartFile(ctx: ProjectContext): Promise<string | null> {
  return findFirstFile(ctx.cwd, [...START_FILE_CANDIDATES]);
}

async function findRootRouteFile(ctx: ProjectContext): Promise<string | null> {
  return findFirstFile(ctx.cwd, [...ROOT_ROUTE_CANDIDATES]);
}

async function detectBaseDir(ctx: ProjectContext): Promise<TanstackBaseDir> {
  const [rootPath, startPath] = await Promise.all([findRootRouteFile(ctx), findStartFile(ctx)]);
  return baseDirFromPath(rootPath) ?? baseDirFromPath(startPath) ?? "src";
}

/**
 * Detect a TanStack Router i18n locale directory in the routes folder.
 * TanStack Router uses `{-$locale}` or `{-$lang}` for optional locale params.
 */
function matchLocaleDir(entry: string): string | null {
  if (/^\{-\$(?:locale|lang)\}$/.test(entry)) return entry;
  return null;
}

async function detectLocaleDir(cwd: string, baseDir: TanstackBaseDir): Promise<string | null> {
  return findFirstDirMatch(cwd, `${baseDir}/routes`, matchLocaleDir);
}

function authRoutePath(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
  kind: "sign-in" | "sign-up",
  localeDir: string | null,
): string {
  const localePart = localeDir ? `${localeDir}/` : "";
  return `${baseDir}/routes/${localePart}${kind}.$.${jsxExt(ctx)}`;
}

async function scaffoldAuthRoutes(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
  localeDir: string | null,
): Promise<FileAction[]> {
  const tailwind = hasTailwindStyles(ctx);
  return scaffoldAuthFiles(
    ctx.cwd,
    authFileSpecs({
      path: (kind) => authRoutePath(ctx, baseDir, kind, localeDir),
      content: (kind) => authRouteContent(kind, tailwind),
      surface: "route",
    }),
  );
}

function newStartFileContent(): string {
  return `import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [clerkMiddleware()],
  };
});
`;
}

async function scaffoldStartServer(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
): Promise<FileAction> {
  const serverPath = await findStartFile(ctx);

  if (!serverPath) {
    const newPath = `${baseDir}/start.ts`;
    return {
      path: newPath,
      type: "create",
      content: newStartFileContent(),
      description: "Create start.ts with clerkMiddleware",
    };
  }

  const content = await Bun.file(join(ctx.cwd, serverPath)).text();

  if (hasClerkImport(content)) {
    return { type: "skip", path: serverPath, skipReason: "Already has Clerk middleware" };
  }

  let newContent = safeAddImport(content, "@clerk/tanstack-react-start/server", "clerkMiddleware");

  // Insert requestMiddleware into createStart config
  if (newContent.includes("createStart")) {
    newContent = newContent.replace(
      /(createStart\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?return\s*\{)/,
      "$1\n    requestMiddleware: [clerkMiddleware()],",
    );
  }

  return {
    path: serverPath,
    type: "modify",
    content: newContent,
    description: "Add clerkMiddleware to request middleware",
  };
}

async function scaffoldRoot(ctx: ProjectContext): Promise<FileAction | null> {
  const rootPath = await findRootRouteFile(ctx);
  if (!rootPath) return null;

  const content = await Bun.file(join(ctx.cwd, rootPath)).text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path: rootPath, skipReason: "Already has ClerkProvider" };
  }

  let newContent = safeAddImport(content, "@clerk/tanstack-react-start", "ClerkProvider");

  if (newContent.includes("<body")) {
    newContent = wrapBodyWithProvider(newContent, "ClerkProvider");
  }

  return {
    path: rootPath,
    type: "modify",
    content: newContent,
    description: "Add ClerkProvider import and wrap body contents",
  };
}

export const tanstackStart: FrameworkScaffold = {
  name: "TanStack Start",
  dep: "@tanstack/react-start",

  matches: (ctx) => ctx.framework.dep === "@tanstack/react-start",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [rootAction, baseDir, envAction] = await Promise.all([
      scaffoldRoot(ctx),
      detectBaseDir(ctx),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.vite),
    ]);
    const [serverAction, localeDir] = await Promise.all([
      scaffoldStartServer(ctx, baseDir),
      detectLocaleDir(ctx.cwd, baseDir),
    ]);
    const authActions = await scaffoldAuthRoutes(ctx, baseDir, localeDir);

    const actions = [serverAction, rootAction, ...authActions, envAction].filter(
      (action): action is FileAction => action !== null,
    );
    const postInstructions: string[] = [];

    if (!rootAction) {
      postInstructions.push(
        "Wrap your root route with <ClerkProvider> from @clerk/tanstack-react-start",
      );
    }

    return { actions, postInstructions };
  },
};
