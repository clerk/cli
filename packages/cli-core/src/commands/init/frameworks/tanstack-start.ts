import { dirname, join } from "node:path";
import { detectCodeFormat, parseModule } from "magicast";
import type { ASTNode } from "magicast";
import { gte, minVersion, valid, validRange } from "semver";
import {
  addBootstrapHeader,
  authComponentName,
  authFileSpecs,
  findFirstFile,
  findFirstDirMatch,
  hasTailwindStyles,
  indentBlock,
  insertAfterLastImport,
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

// 1.168.10 is the first release that names createCsrfMiddleware in its own
// exports (TanStack/router#7466); it pins @tanstack/react-router 1.170.7.
// Keep both in sync with @clerk/tanstack-react-start's peer dependencies.
const MIN_START_VERSION = "1.168.10";
const MIN_START_RANGE = `^${MIN_START_VERSION}`;
const MIN_ROUTER_RANGE = "^1.170.7";

type StartVersionCheck = "supported" | "outdated" | "unknown";

type StartScaffoldResult = {
  action: FileAction;
  postInstructions: string[];
};

type StartFileUpdate =
  | { status: "manual"; needsClerk: boolean }
  | { status: "upgrade"; needsClerk: boolean }
  | { status: "unverified"; needsClerk: boolean }
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

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [csrfMiddleware, clerkMiddleware()],
  };
});
`;
}

/** Read the installed version, walking up so hoisted monorepo installs resolve too. */
async function installedStartVersion(cwd: string): Promise<string | null> {
  let dir = cwd;
  while (true) {
    const file = Bun.file(join(dir, "node_modules/@tanstack/react-start/package.json"));
    if (await file.exists()) {
      try {
        const { version } = (await file.json()) as { version?: unknown };
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Check whether the app's Start version exports createCsrfMiddleware. Prefers
 * the installed version; falls back to the lower bound of the declared range.
 * Specifiers without a usable lower bound (`latest`, `catalog:`, `workspace:*`,
 * `*`) can't be verified.
 */
function checkStartVersion(
  installed: string | null,
  specifier: string | undefined,
): StartVersionCheck {
  if (installed && valid(installed)) {
    return gte(installed, MIN_START_VERSION) ? "supported" : "outdated";
  }
  if (!specifier || !validRange(specifier)) return "unknown";
  const minimum = minVersion(specifier);
  if (!minimum || minimum.version === "0.0.0") return "unknown";
  return gte(minimum, MIN_START_VERSION) ? "supported" : "outdated";
}

function startVersionInstruction(check: StartVersionCheck, specifier: string | undefined): string {
  return check === "outdated"
    ? `Upgrade @tanstack/react-start to ${MIN_START_RANGE} and @tanstack/react-router to ${MIN_ROUTER_RANGE} before adding CSRF middleware`
    : `Could not confirm @tanstack/react-start${specifier ? ` (${specifier})` : ""} is ${MIN_START_VERSION} or newer; make sure it's on ${MIN_START_RANGE} and @tanstack/react-router on ${MIN_ROUTER_RANGE} before adding CSRF middleware`;
}

type CodeStyle = { quote: string; semi: string };

function codeStyle(content: string): CodeStyle {
  const format = detectCodeFormat(content);
  return {
    quote: format.quote === "single" ? "'" : '"',
    semi: format.useSemi === false ? "" : ";",
  };
}

/** Add a named import in the file's style, merging into a one-line import from the same source. */
function addNamedImport(code: string, source: string, name: string, style: CodeStyle): string {
  const existing = [...code.matchAll(/^import \{([^}\n]*)\} from (["'])([^"'\n]+)\2/gm)].find(
    (match) => match[3] === source,
  );
  if (existing) {
    const names = existing[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (names.includes(name)) return code;
    const index = names.findIndex((item) => item > name);
    names.splice(index < 0 ? names.length : index, 0, name);
    const quote = existing[2]!;
    return code.replace(
      existing[0],
      () => `import { ${names.join(", ")} } from ${quote}${source}${quote}`,
    );
  }
  return insertAfterLastImport(
    code,
    `import { ${name} } from ${style.quote}${source}${style.quote}${style.semi}\n`,
  );
}

function updateStartFile(content: string, startVersion: StartVersionCheck): StartFileUpdate {
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
    const property = properties[0];
    if (
      property &&
      (property.type !== "ObjectProperty" || property.value.type !== "ArrayExpression")
    ) {
      return { status: "manual", needsClerk: true };
    }
    const array = property?.value.type === "ArrayExpression" ? property.value : null;
    const middleware = array?.elements ?? [];
    if (middleware.some((element) => element === null)) {
      return { status: "manual", needsClerk: true };
    }
    // Local names the Clerk middleware is imported under, so aliases count.
    const clerkImports = program.body.flatMap((statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === "@clerk/tanstack-react-start/server"
        ? statement.specifiers.flatMap((specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "clerkMiddleware"
              ? [specifier.local.name]
              : [],
          )
        : [],
    );
    const clerkName = clerkImports[0] ?? "clerkMiddleware";
    const isClerkCall = (node: ASTNode | null | undefined): boolean =>
      node?.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (node.callee.name === "clerkMiddleware" || clerkImports.includes(node.callee.name));
    const callbackStatements = callback.body.type === "BlockStatement" ? callback.body.body : [];
    // Resolve a middleware variable to its nearest declaration, callback scope first.
    const isClerkVariable = (name: string): boolean => {
      for (const statements of [callbackStatements, program.body]) {
        const declarations = statements.flatMap((statement) => {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          return declaration?.type === "VariableDeclaration"
            ? declaration.declarations.filter(
                (declarator) => declarator.id.type === "Identifier" && declarator.id.name === name,
              )
            : [];
        });
        if (declarations.length > 0) {
          return declarations.length === 1 && isClerkCall(declarations[0]!.init);
        }
      }
      return false;
    };
    const hasClerk = middleware.some(
      (element) =>
        isClerkCall(element) || (element?.type === "Identifier" && isClerkVariable(element.name)),
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
      if (startVersion !== "supported") {
        return {
          status: startVersion === "outdated" ? "upgrade" : "unverified",
          needsClerk: !hasClerk,
        };
      }
      // Only an empty array or the old Clerk-only array is safe to rewrite automatically.
      if (
        (middleware.length > 0 && !(middleware.length === 1 && hasClerk)) ||
        content.includes("csrfMiddleware") ||
        content.includes("createCsrfMiddleware")
      ) {
        return { status: "manual", needsClerk: !hasClerk };
      }
    }
    if (hasClerk && hasCsrf) return { status: "unchanged", content };

    // Splice text at the AST positions instead of regenerating the module, so
    // the rest of the file keeps its exact formatting.
    const before = hasCsrf ? [] : ["csrfMiddleware"];
    const after = hasClerk ? [] : [`${clerkName}()`];
    const edits: { at: number; text: string }[] = [];
    const first = middleware[0];
    const last = middleware.at(-1);
    if (array && first && last) {
      // Keep one element per line when the array is already split across lines.
      const separator =
        first.loc!.start.line === array.loc!.start.line
          ? ", "
          : `,\n${" ".repeat(first.loc!.start.column)}`;
      if (before.length > 0) {
        edits.push({ at: first.start!, text: `${before.join(separator)}${separator}` });
      }
      if (after.length > 0) {
        edits.push({ at: last.end!, text: `${separator}${after.join(separator)}` });
      }
    } else if (array) {
      edits.push({ at: array.start! + 1, text: [...before, ...after].join(", ") });
    } else {
      const entry = `requestMiddleware: [${[...before, ...after].join(", ")}]`;
      const firstProperty = config.properties[0];
      edits.push(
        firstProperty
          ? {
              at: firstProperty.start!,
              text: `${entry},\n${" ".repeat(firstProperty.loc!.start.column)}`,
            }
          : { at: config.start! + 1, text: ` ${entry} ` },
      );
    }
    if (edits.some((edit) => !Number.isInteger(edit.at))) {
      return { status: "manual", needsClerk: !hasClerk };
    }
    let result = content;
    for (const edit of edits.sort((a, b) => b.at - a.at)) {
      result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
    }

    const style = codeStyle(content);
    if (clerkImports.length === 0) {
      result = addNamedImport(
        result,
        "@clerk/tanstack-react-start/server",
        "clerkMiddleware",
        style,
      );
    }
    if (!hasCsrf) {
      result = addNamedImport(result, "@tanstack/react-start", "createCsrfMiddleware", style);
      const declaration = `const csrfMiddleware = createCsrfMiddleware({\n  filter: (ctx) => ctx.handlerType === ${style.quote}serverFn${style.quote},\n})${style.semi}\n`;
      result = insertAfterLastImport(result, `\n${declaration}`);
      // Keep a blank line between the new declaration and the code after it.
      result = result.replace(declaration, (match, offset: number, code: string) =>
        code[offset + match.length] === "\n" ? match : `${match}\n`,
      );
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
  const specifier = ctx.deps["@tanstack/react-start"];
  const startVersion = checkStartVersion(await installedStartVersion(ctx.cwd), specifier);

  if (!serverPath) {
    const newPath = `${baseDir}/start.ts`;
    if (startVersion !== "supported") {
      return {
        action: {
          type: "skip",
          path: newPath,
          skipReason: `Needs @tanstack/react-start ${MIN_START_RANGE} for CSRF middleware`,
        },
        postInstructions: [
          startVersionInstruction(startVersion, specifier),
          `Then create ${newPath} that registers createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }) and clerkMiddleware() in requestMiddleware, in that order`,
        ],
      };
    }
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
  const update = updateStartFile(content, startVersion);
  const postInstructions: string[] = [];

  if (update.status === "manual" || update.status === "upgrade" || update.status === "unverified") {
    if (update.needsClerk) {
      postInstructions.push(
        `Add clerkMiddleware() from @clerk/tanstack-react-start/server to requestMiddleware in ${serverPath}, after any CSRF middleware`,
      );
    }
    if (update.status !== "manual") {
      postInstructions.push(startVersionInstruction(startVersion, specifier));
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
