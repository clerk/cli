import { join } from "node:path";
import { parseModule } from "magicast";
import {
  findFirstFile,
  insertAfterLastImport,
  safeAddImport,
  scaffoldAuthPage,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function signInRouteContent(): string {
  return `import { SignIn } from "@clerk/react-router";

export default function SignInPage() {
  return <SignIn />;
}
`;
}

function signUpRouteContent(): string {
  return `import { SignUp } from "@clerk/react-router";

export default function SignUpPage() {
  return <SignUp />;
}
`;
}

function addServerImports(source: string): string {
  if (source.includes("@clerk/react-router/server")) return source;

  let result = safeAddImport(source, "@clerk/react-router/server", "clerkMiddleware");
  result = safeAddImport(result, "@clerk/react-router/server", "rootAuthLoader");
  return result;
}

function addMiddlewareExport(source: string, typescript: boolean): string {
  if (source.includes("export const middleware")) return source;
  const typeAnnotation = typescript ? ": Route.MiddlewareFunction[]" : "";
  return insertAfterLastImport(
    source,
    `\nexport const middleware${typeAnnotation} = [clerkMiddleware()];\n`,
  );
}

function addLoaderExport(source: string, typescript: boolean): string {
  if (source.includes("rootAuthLoader")) return source;

  const middlewareIdx = source.indexOf("export const middleware");
  if (middlewareIdx === -1) return source;

  const lineEnd = source.indexOf("\n", middlewareIdx);
  if (lineEnd === -1) return source;

  const argsParam = typescript ? "(args: Route.LoaderArgs)" : "(args)";
  return (
    source.slice(0, lineEnd + 1) +
    `\nexport const loader = ${argsParam} => rootAuthLoader(args);\n` +
    source.slice(lineEnd + 1)
  );
}

function wrapOutletWithProvider(source: string): string {
  if (!source.includes("<Outlet") || source.includes("<ClerkProvider")) return source;
  return source.replace(
    /(<Outlet\s*\/>)/,
    "<ClerkProvider loaderData={loaderData}>\n        $1\n      </ClerkProvider>",
  );
}

async function scaffoldRoot(ctx: ProjectContext): Promise<FileAction | null> {
  const rootPath = await findFirstFile(ctx.cwd, ["app/root.tsx", "app/root.jsx"]);
  if (!rootPath) return null;

  const content = await Bun.file(join(ctx.cwd, rootPath)).text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path: rootPath, skipReason: "Already has ClerkProvider" };
  }

  let result = addServerImports(content);
  result = safeAddImport(result, "@clerk/react-router", "ClerkProvider");
  result = addMiddlewareExport(result, ctx.typescript);
  result = addLoaderExport(result, ctx.typescript);
  result = wrapOutletWithProvider(result);

  return {
    path: rootPath,
    type: "modify",
    content: result,
    description: "Add ClerkProvider, clerkMiddleware, and rootAuthLoader",
  };
}

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

async function scaffoldConfig(ctx: ProjectContext): Promise<FileAction | null> {
  const configPath = await findFirstFile(ctx.cwd, [
    "react-router.config.ts",
    "react-router.config.js",
  ]);
  if (!configPath) return null;

  const content = await Bun.file(join(ctx.cwd, configPath)).text();

  if (content.includes("v8_middleware")) {
    return { type: "skip", path: configPath, skipReason: "Already has v8_middleware flag" };
  }

  const newContent = enableV8Middleware(content);

  return {
    path: configPath,
    type: "modify",
    content: newContent,
    description: "Enable v8_middleware future flag for Clerk middleware",
  };
}

export const reactRouter: FrameworkScaffold = {
  name: "React Router",
  dep: "react-router",
  minMajorVersion: 7,

  matches: (ctx) => ctx.framework.dep === "react-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const configAction = await scaffoldConfig(ctx);
    if (configAction) {
      actions.push(configAction);
    }

    const rootAction = await scaffoldRoot(ctx);
    if (rootAction) {
      actions.push(rootAction);
    } else {
      postInstructions.push(
        "Add ClerkProvider, clerkMiddleware(), and rootAuthLoader() to your app/root.tsx. See: https://clerk.com/docs/quickstarts/react-router",
      );
    }

    const ext = ctx.typescript ? "tsx" : "jsx";
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        `app/routes/sign-in.${ext}`,
        signInRouteContent(),
        "sign-in route",
      ),
    );
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        `app/routes/sign-up.${ext}`,
        signUpRouteContent(),
        "sign-up route",
      ),
    );

    postInstructions.push(
      "Add sign-in and sign-up routes to app/routes.ts: route('sign-in/*', 'routes/sign-in.tsx') and route('sign-up/*', 'routes/sign-up.tsx')",
    );

    return { actions, postInstructions };
  },
};
