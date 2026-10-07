import { join } from "node:path";
import { builders, parseModule } from "magicast";
import type { ASTNode } from "magicast";
import {
  addBootstrapHeader,
  authComponentName,
  authFileSpecs,
  findFirstFile,
  findFirstDirMatch,
  hasTailwindStyles,
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

type StartScaffoldResult = {
  action: FileAction;
  /** True when the start file exists but Clerk couldn't be added — user must register it manually. */
  needsManualMiddleware: boolean;
};

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

async function findStartFile(
  ctx: ProjectContext,
  baseDir?: TanstackBaseDir,
): Promise<string | null> {
  const candidates = baseDir
    ? START_FILE_CANDIDATES.filter((c) => c.startsWith(`${baseDir}/`))
    : [...START_FILE_CANDIDATES];
  return findFirstFile(ctx.cwd, candidates);
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
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, clerkMiddleware()],
}));
`;
}

function addClerkToStart(content: string): string | null {
  try {
    const mod = parseModule(content);
    const calls: Extract<ASTNode, { type: "CallExpression" }>[] = [];
    const visited = new WeakSet<object>();

    function visit(node: ASTNode): void {
      if (visited.has(node)) return;
      visited.add(node);
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "createStart"
      ) {
        calls.push(node);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "original" || key === "loc" || key === "comments") continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === "object" && "type" in child) visit(child as ASTNode);
        }
      }
    }

    visit(mod.$ast);
    if (calls.length !== 1) return null;

    const callback = calls[0]!.arguments[0];
    if (!callback || callback.type !== "ArrowFunctionExpression") return null;

    let config: Extract<ASTNode, { type: "ObjectExpression" }> | null = null;
    if (callback.body.type === "ObjectExpression") {
      config = callback.body;
    } else if (callback.body.type === "BlockStatement") {
      const returns = callback.body.body.filter(
        (statement) => statement.type === "ReturnStatement",
      );
      if (returns.length === 1 && returns[0]!.argument?.type === "ObjectExpression") {
        config = returns[0]!.argument;
      }
    }
    if (!config) return null;

    // A spread could override requestMiddleware after our edit, and its contents are unknown.
    if (config.properties.some((property) => property.type === "SpreadElement")) return null;

    const middlewareProperties = config.properties.filter(
      (property) =>
        (property.type === "ObjectProperty" || property.type === "ObjectMethod") &&
        ((property.key.type === "Identifier" && property.key.name === "requestMiddleware") ||
          (property.key.type === "StringLiteral" && property.key.value === "requestMiddleware")),
    );
    if (middlewareProperties.length > 1) return null;

    const middlewareProperty = middlewareProperties[0];
    const clerkCall = builders.raw("clerkMiddleware()").$ast;
    if (clerkCall.type !== "CallExpression") return null;

    if (middlewareProperty) {
      if (
        middlewareProperty.type !== "ObjectProperty" ||
        middlewareProperty.value.type !== "ArrayExpression"
      ) {
        return null;
      }
      const middleware = middlewareProperty.value.elements;
      if (
        middleware.some(
          (element) =>
            element?.type === "CallExpression" &&
            element.callee.type === "Identifier" &&
            element.callee.name === "clerkMiddleware",
        )
      ) {
        return content;
      }
      middleware.push(clerkCall);
    } else {
      const property = builders.raw("({ requestMiddleware: [clerkMiddleware()] })").$ast;
      if (property.type !== "ObjectExpression") return null;
      config.properties.unshift(property.properties[0]!);
    }

    const result = mod.generate().code;
    const hasImport =
      mod.$ast.type === "Program" &&
      mod.$ast.body.some(
        (statement) =>
          statement.type === "ImportDeclaration" &&
          statement.source.value === "@clerk/tanstack-react-start/server" &&
          statement.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" && specifier.local.name === "clerkMiddleware",
          ),
      );
    return hasImport
      ? result
      : safeAddImport(result, "@clerk/tanstack-react-start/server", "clerkMiddleware");
  } catch {
    return null;
  }
}

async function scaffoldStartServer(
  ctx: ProjectContext,
  baseDir: TanstackBaseDir,
): Promise<StartScaffoldResult> {
  const serverPath = await findStartFile(ctx, baseDir);

  if (!serverPath) {
    const newPath = `${baseDir}/start.ts`;
    return {
      action: {
        path: newPath,
        type: "create",
        content: newStartFileContent(),
        description: "Create start.ts with CSRF and Clerk middleware",
      },
      needsManualMiddleware: false,
    };
  }

  const content = await Bun.file(join(ctx.cwd, serverPath)).text();

  const newContent = addClerkToStart(content);
  if (newContent === null) {
    return {
      action: {
        type: "skip",
        path: serverPath,
        skipReason:
          "Could not safely add Clerk to requestMiddleware — add clerkMiddleware() manually",
      },
      needsManualMiddleware: true,
    };
  }
  if (newContent === content) {
    return {
      action: { type: "skip", path: serverPath, skipReason: "Already has Clerk middleware" },
      needsManualMiddleware: false,
    };
  }

  return {
    action: {
      path: serverPath,
      type: "modify",
      content: newContent,
      description: "Add clerkMiddleware to request middleware",
    },
    needsManualMiddleware: false,
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

  if (ctx.isBootstrap) {
    newContent = addBootstrapHeader(
      newContent,
      "@clerk/tanstack-react-start",
      hasTailwindStyles(ctx),
    );
  }

  const description = ctx.isBootstrap
    ? "Add ClerkProvider, wrap body contents, and add auth header"
    : "Add ClerkProvider import and wrap body contents";

  return { path: rootPath, type: "modify", content: newContent, description };
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
    const [serverResult, localeDir] = await Promise.all([
      scaffoldStartServer(ctx, baseDir),
      detectLocaleDir(ctx.cwd, baseDir),
    ]);
    const authActions = await scaffoldAuthRoutes(ctx, baseDir, localeDir);

    const actions = [serverResult.action, rootAction, ...authActions, envAction].filter(
      (action): action is FileAction => action !== null,
    );
    const postInstructions: string[] = [];

    if (serverResult.needsManualMiddleware) {
      postInstructions.push(
        `Add clerkMiddleware() from @clerk/tanstack-react-start/server to requestMiddleware in ${serverResult.action.path}, after any CSRF middleware`,
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
