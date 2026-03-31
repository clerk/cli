import { join } from "node:path";
import {
  authComponentName,
  authFileSpecs,
  findFirstFile,
  hasTailwindStyles,
  htmlAuthComponentMarkup,
  indentBlock,
  insertAfterLastImport,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldEnvVars,
  scriptExt,
  SIGN_ROUTE_ENV_VARS,
  srcPrefix,
} from "./helpers.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

async function findEntryFile(ctx: ProjectContext): Promise<string | null> {
  const base = srcPrefix(ctx);
  return findFirstFile(ctx.cwd, [`${base}main.ts`, `${base}main.js`]);
}

function addClerkPluginSetup(source: string): string {
  const keyBlock = `\nconst PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;\n\nif (!PUBLISHABLE_KEY) {\n  throw new Error("Add your Clerk Publishable Key to the .env file");\n}\n`;

  let result = source;

  // Handle chained pattern: createApp(App).mount(...) -> split into separate statements
  const chainedPattern = /(createApp\([^)]*\))\.mount\s*\(([^)]*)\)/;
  if (chainedPattern.test(result)) {
    result = result.replace(
      chainedPattern,
      `const app = $1;\napp.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });\napp.mount($2)`,
    );
  } else {
    // Handle variable pattern: app.mount(...) -> insert app.use() before it
    result = result.replace(
      /((\w+)\.mount\s*\()/,
      `$2.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });\n$1`,
    );
  }

  return insertAfterLastImport(result, keyBlock);
}

function newEntryContent(): string {
  return `import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
import App from "./App.vue";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Add your Clerk Publishable Key to the .env file");
}

const app = createApp(App);
app.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });
app.mount("#app");
`;
}

async function scaffoldEntry(ctx: ProjectContext): Promise<FileAction> {
  const entryPath = await findEntryFile(ctx);

  if (!entryPath) {
    const base = srcPrefix(ctx);
    const ext = scriptExt(ctx);
    return {
      type: "create",
      path: `${base}main.${ext}`,
      content: newEntryContent(),
      description: "Create entry file with clerkPlugin setup",
    };
  }

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("clerkPlugin") || content.includes("@clerk/vue")) {
    return { type: "skip", path: entryPath, skipReason: "Already has Clerk plugin" };
  }

  let newContent = safeAddImport(content, "@clerk/vue", "clerkPlugin");

  // Add the publishable key constant and app.use() call before app.mount()
  if (newContent.includes(".mount(")) {
    newContent = addClerkPluginSetup(newContent);
  }

  return {
    path: entryPath,
    type: "modify",
    content: newContent,
    description: "Add clerkPlugin with publishableKey to Vue app",
  };
}

function authPageContent(kind: "sign-in" | "sign-up", tailwind: boolean): string {
  const component = authComponentName(kind);
  const content = indentBlock(htmlAuthComponentMarkup(component, tailwind), "  ");
  return `<script setup>
import { ${component} } from "@clerk/vue";
</script>

<template>
${content}
</template>
`;
}

async function findRouterFile(ctx: ProjectContext): Promise<string | null> {
  const base = srcPrefix(ctx);
  const ext = scriptExt(ctx);
  return findFirstFile(ctx.cwd, [`${base}router/index.${ext}`, `${base}router.${ext}`]);
}

function addSignRoutes(source: string, viewPrefix: string): string {
  if (source.includes("/sign-in") || source.includes("/sign-up")) {
    return source;
  }

  // Insert sign-in/sign-up routes before the closing ] of the routes array
  return source.replace(
    /(routes:\s*\[)([\s\S]*?)(\s*\])/,
    `$1$2\n    {\n      path: "/sign-in",\n      component: () => import("${viewPrefix}views/sign-in.vue"),\n    },\n    {\n      path: "/sign-up",\n      component: () => import("${viewPrefix}views/sign-up.vue"),\n    },$3`,
  );
}

async function scaffoldRouter(ctx: ProjectContext): Promise<FileAction | null> {
  const routerPath = await findRouterFile(ctx);
  if (!routerPath) return null;

  const content = await Bun.file(join(ctx.cwd, routerPath)).text();

  if (content.includes("/sign-in") || content.includes("/sign-up")) {
    return { type: "skip", path: routerPath, skipReason: "Already has sign-in/sign-up routes" };
  }

  const newContent = addSignRoutes(content, routerPath.includes("router/") ? "../" : "./");
  if (newContent === content) return null;

  return {
    path: routerPath,
    type: "modify",
    content: newContent,
    description: "Add sign-in and sign-up routes",
  };
}

export const vue: FrameworkScaffold = {
  name: "Vue",
  dep: "vue",
  minMajorVersion: 3,

  matches: (ctx) => ctx.framework.dep === "vue",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const tailwind = hasTailwindStyles(ctx);
    const base = srcPrefix(ctx);

    const [entryAction, authActions, envAction, routerAction] = await Promise.all([
      scaffoldEntry(ctx),
      scaffoldAuthFiles(
        ctx.cwd,
        authFileSpecs({
          path: (kind) => `${base}views/${kind}.vue`,
          content: (kind) => authPageContent(kind, tailwind),
          surface: "page",
        }),
      ),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.vite),
      scaffoldRouter(ctx),
    ]);

    const actions: FileAction[] = [entryAction, ...authActions, envAction];
    const postInstructions: string[] = [];

    if (routerAction) {
      actions.push(routerAction);
    } else if (ctx.deps["vue-router"]) {
      postInstructions.push(
        "Add sign-in and sign-up routes to your Vue Router config (e.g., `{ path: '/sign-in', component: () => import('./views/sign-in.vue') }`)",
      );
    }

    return { actions, postInstructions };
  },
};
