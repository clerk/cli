import { join } from "node:path";
import {
  findFirstFile,
  hasClerkImport,
  safeAddImport,
  scaffoldAuthPage,
  wrapBodyWithProvider,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function signInRouteContent(): string {
  return `import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in/$")({
  component: Page,
});

function Page() {
  return <SignIn />;
}
`;
}

function signUpRouteContent(): string {
  return `import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  component: Page,
});

function Page() {
  return <SignUp />;
}
`;
}

async function scaffoldStartServer(ctx: ProjectContext): Promise<FileAction | null> {
  const serverPath = await findFirstFile(ctx.cwd, [
    "src/start.ts",
    "src/start.tsx",
    "app/start.ts",
  ]);
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
  const rootPath = await findFirstFile(ctx.cwd, [
    "src/routes/__root.tsx",
    "src/routes/__root.jsx",
    "app/routes/__root.tsx",
  ]);
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
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    const serverAction = await scaffoldStartServer(ctx);
    if (serverAction) {
      actions.push(serverAction);
    } else {
      postInstructions.push(
        "Add clerkMiddleware() to your start server's requestMiddleware. See: https://clerk.com/docs/quickstarts/tanstack-start",
      );
    }

    const rootAction = await scaffoldRoot(ctx);
    if (rootAction) {
      actions.push(rootAction);
    } else {
      postInstructions.push(
        "Wrap your root route with <ClerkProvider> from @clerk/tanstack-react-start",
      );
    }

    const ext = ctx.typescript ? "tsx" : "jsx";
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        `src/routes/sign-in.$.${ext}`,
        signInRouteContent(),
        "sign-in route",
      ),
    );
    actions.push(
      await scaffoldAuthPage(
        ctx.cwd,
        `src/routes/sign-up.$.${ext}`,
        signUpRouteContent(),
        "sign-up route",
      ),
    );

    return { actions, postInstructions };
  },
};
