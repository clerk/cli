import { join } from "node:path";
import { builders, parseModule } from "magicast";
import type { ASTNode } from "magicast";
import { gte, minVersion } from "semver";
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
  postInstructions: string[];
};

type StartFileUpdate =
  | { status: "manual"; needsClerk: boolean }
  | { status: "upgrade"; needsClerk: boolean }
  | { status: "unchanged"; content: string }
  | { status: "modified"; content: string; addedCsrf: boolean };

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
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, clerkMiddleware()],
}));
`;
}

function updateStartFile(content: string, startVersion: string | undefined): StartFileUpdate {
  try {
    const mod = parseModule(content);
    const program = mod.$ast;
    if (program.type !== "Program") return { status: "manual", needsClerk: true };

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
    if (calls.length !== 1) return { status: "manual", needsClerk: true };

    const callback = calls[0]!.arguments[0];
    if (!callback || callback.type !== "ArrowFunctionExpression") {
      return { status: "manual", needsClerk: true };
    }
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
    if (!config || config.properties.some((property) => property.type === "SpreadElement")) {
      return { status: "manual", needsClerk: true };
    }

    const properties = config.properties.filter(
      (property) =>
        (property.type === "ObjectProperty" || property.type === "ObjectMethod") &&
        ((property.key.type === "Identifier" && property.key.name === "requestMiddleware") ||
          (property.key.type === "StringLiteral" && property.key.value === "requestMiddleware")),
    );
    if (properties.length > 1) return { status: "manual", needsClerk: true };
    let property = properties[0];
    if (!property) {
      const empty = builders.raw("({ requestMiddleware: [] })").$ast;
      if (empty.type !== "ObjectExpression") return { status: "manual", needsClerk: true };
      property = empty.properties[0];
      config.properties.unshift(property!);
    }
    if (property?.type !== "ObjectProperty" || property.value.type !== "ArrayExpression") {
      return { status: "manual", needsClerk: true };
    }
    const middleware = property.value.elements;
    const hasClerk = middleware.some(
      (element) =>
        element?.type === "CallExpression" &&
        element.callee.type === "Identifier" &&
        element.callee.name === "clerkMiddleware",
    );

    const hasImport = (source: string, name: string) =>
      program.body.some(
        (statement) =>
          statement.type === "ImportDeclaration" &&
          statement.source.value === source &&
          statement.specifiers.some(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              specifier.imported.type === "Identifier" &&
              specifier.imported.name === name &&
              specifier.local.name === name,
          ),
      );
    const csrfDeclared = program.body.some(
      (statement) =>
        statement.type === "VariableDeclaration" &&
        statement.declarations.some(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            declaration.id.name === "csrfMiddleware" &&
            declaration.init?.type === "CallExpression" &&
            declaration.init.callee.type === "Identifier" &&
            declaration.init.callee.name === "createCsrfMiddleware",
        ),
    );
    const hasCsrf =
      hasImport("@tanstack/react-start", "createCsrfMiddleware") &&
      middleware.some(
        (element) =>
          (element?.type === "Identifier" && element.name === "csrfMiddleware" && csrfDeclared) ||
          (element?.type === "CallExpression" &&
            element.callee.type === "Identifier" &&
            element.callee.name === "createCsrfMiddleware"),
      );

    if (!hasCsrf) {
      const minimum = startVersion ? minVersion(startVersion) : null;
      if (!minimum || !gte(minimum, "1.168.0")) {
        return { status: "upgrade", needsClerk: !hasClerk };
      }
      // Only an empty array or the old Clerk-only array is safe to rewrite automatically.
      if (
        (middleware.length > 0 && !(middleware.length === 1 && hasClerk)) ||
        content.includes("csrfMiddleware") ||
        content.includes("createCsrfMiddleware")
      ) {
        return { status: "manual", needsClerk: !hasClerk };
      }
      const declaration = parseModule(
        'const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });',
      ).$ast;
      const csrfElement = builders.raw("csrfMiddleware").$ast;
      if (declaration.type !== "Program" || csrfElement.type !== "Identifier") {
        return { status: "manual", needsClerk: !hasClerk };
      }
      const insertAt = program.body.findIndex(
        (statement) => statement.type !== "ImportDeclaration",
      );
      program.body.splice(insertAt < 0 ? program.body.length : insertAt, 0, declaration.body[0]!);
      middleware.unshift(csrfElement);
    }

    if (!hasClerk) {
      const clerkCall = builders.raw("clerkMiddleware()").$ast;
      if (clerkCall.type !== "CallExpression") return { status: "manual", needsClerk: true };
      middleware.push(clerkCall);
    }
    if (hasClerk && hasCsrf) return { status: "unchanged", content };

    let result = mod.generate().code;
    if (!hasImport("@clerk/tanstack-react-start/server", "clerkMiddleware")) {
      result = safeAddImport(result, "@clerk/tanstack-react-start/server", "clerkMiddleware");
    }
    if (!hasCsrf) {
      result = safeAddImport(result, "@tanstack/react-start", "createCsrfMiddleware");
    }
    return { status: "modified", content: result, addedCsrf: !hasCsrf };
  } catch {
    return { status: "manual", needsClerk: true };
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
      postInstructions: [],
    };
  }

  const content = await Bun.file(join(ctx.cwd, serverPath)).text();
  const update = updateStartFile(content, ctx.deps["@tanstack/react-start"]);
  const postInstructions: string[] = [];

  if (update.status === "manual" || update.status === "upgrade") {
    if (update.needsClerk) {
      postInstructions.push(
        `Add clerkMiddleware() from @clerk/tanstack-react-start/server to requestMiddleware in ${serverPath}, after any CSRF middleware`,
      );
    }
    if (update.status === "upgrade") {
      postInstructions.push(
        "Upgrade @tanstack/react-start to ^1.168.0 and @tanstack/react-router to ^1.170.0 before adding CSRF middleware",
      );
    }
    postInstructions.push(
      `In ${serverPath}, register createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }) before clerkMiddleware() in requestMiddleware if equivalent CSRF protection is not already configured`,
    );
    return {
      action: {
        type: "skip",
        path: serverPath,
        skipReason: update.needsClerk
          ? "Could not safely add Clerk to requestMiddleware — add clerkMiddleware() manually"
          : "Could not safely add CSRF middleware automatically",
      },
      postInstructions,
    };
  }
  if (update.status === "unchanged") {
    return {
      action: { type: "skip", path: serverPath, skipReason: "Already has Clerk middleware" },
      postInstructions,
    };
  }

  return {
    action: {
      path: serverPath,
      type: "modify",
      content: update.content,
      description: update.addedCsrf
        ? "Add CSRF middleware before Clerk in requestMiddleware"
        : "Add clerkMiddleware to request middleware",
    },
    postInstructions,
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
    const postInstructions = [...serverResult.postInstructions];

    if (!rootAction) {
      postInstructions.push(
        "Wrap your root route with <ClerkProvider> from @clerk/tanstack-react-start",
      );
    }

    return { actions, postInstructions };
  },
};
