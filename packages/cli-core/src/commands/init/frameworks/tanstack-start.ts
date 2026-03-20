import { join } from "node:path";
import {
  authComponentName,
  findFirstFile,
  hasClerkImport,
  jsxExt,
  safeAddImport,
  scaffoldAuthFiles,
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

function authRouteContent(kind: "sign-in" | "sign-up"): string {
  const component = authComponentName(kind);

  return `import { ${component} } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/${kind}/$")({
  component: Page,
});

function Page() {
  return <${component} />;
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

function authRoutePath(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
  kind: "sign-in" | "sign-up",
): string {
  return `${baseDir}/routes/${kind}.$.${jsxExt(ctx)}`;
}

async function scaffoldAuthRoutes(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
): Promise<FileAction[]> {
  return scaffoldAuthFiles(ctx.cwd, [
    {
      path: authRoutePath(ctx, baseDir, "sign-in"),
      content: authRouteContent("sign-in"),
      kind: "sign-in",
      surface: "route",
    },
    {
      path: authRoutePath(ctx, baseDir, "sign-up"),
      content: authRouteContent("sign-up"),
      kind: "sign-up",
      surface: "route",
    },
  ]);
}

async function scaffoldStartServer(ctx: ProjectContext): Promise<FileAction | null> {
  const serverPath = await findStartFile(ctx);
  if (!serverPath) return null;

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
    const [serverAction, rootAction, baseDir] = await Promise.all([
      scaffoldStartServer(ctx),
      scaffoldRoot(ctx),
      detectBaseDir(ctx),
    ]);
    const authActions = await scaffoldAuthRoutes(ctx, baseDir);

    const actions = [serverAction, rootAction, ...authActions].filter(
      (action): action is FileAction => action !== null,
    );
    const postInstructions: string[] = [];

    if (!serverAction) {
      postInstructions.push(
        "Add clerkMiddleware() to your start server's requestMiddleware. See: https://clerk.com/docs/quickstarts/tanstack-start",
      );
    }

    if (!rootAction) {
      postInstructions.push(
        "Wrap your root route with <ClerkProvider> from @clerk/tanstack-react-start",
      );
    }

    return { actions, postInstructions };
  },
};
