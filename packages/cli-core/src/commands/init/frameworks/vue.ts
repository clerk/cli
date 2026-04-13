import { join } from "node:path";
import {
  authComponentName,
  authFileSpecs,
  findFirstFile,
  hasTailwindStyles,
  headerHtmlBlock,
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
  const keyBlock = `\nconst PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;\nif (!PUBLISHABLE_KEY) {\n  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY. Add your key to .env.local.\\nRun: 1) clerk auth login  2) clerk link  3) clerk env pull — then restart the dev server.");\n}\n`;

  let result = source;

  const useClerk = `app.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });`;

  // Handle chained pattern: createApp(App).mount(...) -> split into separate statements
  const chainedPattern = /(createApp\([^)]*\))\.mount\s*\(([^)]*)\)/;
  if (chainedPattern.test(result)) {
    result = result.replace(chainedPattern, `const app = $1;\n${useClerk}\napp.mount($2)`);
  } else {
    // Handle variable pattern: app.mount(...) -> insert app.use() before it
    result = result.replace(/((\w+)\.mount\s*\()/, `${useClerk}\n$1`);
  }

  return insertAfterLastImport(result, keyBlock);
}

function newEntryContent(withRouter = false): string {
  const routerImport = withRouter ? `import router from "./router";\n` : "";
  const routerUse = withRouter ? `app.use(router);\n` : "";
  return `import { createApp } from "vue";
import { clerkPlugin } from "@clerk/vue";
import App from "./App.vue";
${routerImport}
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY. Add your key to .env.local.\\nRun: 1) clerk auth login  2) clerk link  3) clerk env pull — then restart the dev server.");
}

const app = createApp(App);
app.use(clerkPlugin, { publishableKey: PUBLISHABLE_KEY });
${routerUse}app.mount("#app");
`;
}

async function scaffoldEntry(ctx: ProjectContext, withRouter = false): Promise<FileAction> {
  const entryPath = await findEntryFile(ctx);

  if (!entryPath) {
    const base = srcPrefix(ctx);
    const ext = scriptExt(ctx);
    return {
      type: "create",
      path: `${base}main.${ext}`,
      content: newEntryContent(withRouter),
      description: "Create entry file with clerkPlugin setup",
    };
  }

  const content = await Bun.file(join(ctx.cwd, entryPath)).text();

  if (content.includes("clerkPlugin") || content.includes("@clerk/vue")) {
    return { type: "skip", path: entryPath, skipReason: "Already has Clerk plugin" };
  }

  let newContent = safeAddImport(content, "@clerk/vue", "clerkPlugin");

  if (withRouter) {
    newContent = insertAfterLastImport(newContent, `\nimport router from "./router";\n`);
  }

  // Add the publishable key constant and app.use() call before app.mount()
  const hasMount = newContent.includes(".mount(");
  if (hasMount) newContent = addClerkPluginSetup(newContent);
  if (hasMount && withRouter)
    newContent = newContent.replace(/(.+\.mount\s*\()/, `app.use(router);\n$1`);

  const description = withRouter
    ? "Add clerkPlugin with publishableKey and vue-router to Vue app"
    : "Add clerkPlugin with publishableKey to Vue app";

  return { path: entryPath, type: "modify", content: newContent, description };
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

function newRouterContent(viewPrefix: string): string {
  return `import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/sign-in",
      component: () => import("${viewPrefix}views/sign-in.vue"),
    },
    {
      path: "/sign-up",
      component: () => import("${viewPrefix}views/sign-up.vue"),
    },
  ],
});

export default router;
`;
}

function scaffoldNewRouter(ctx: ProjectContext): FileAction {
  const base = srcPrefix(ctx);
  const ext = scriptExt(ctx);
  return {
    type: "create",
    path: `${base}router/index.${ext}`,
    content: newRouterContent("../"),
    description: "Create vue-router config with sign-in and sign-up routes",
  };
}

async function scaffoldAppVue(ctx: ProjectContext, tailwind: boolean): Promise<FileAction | null> {
  const base = srcPrefix(ctx);
  const appPath = await findFirstFile(ctx.cwd, [`${base}App.vue`]);
  if (!appPath) return null;

  if (!ctx.isBootstrap) {
    return {
      path: appPath,
      type: "modify",
      content: `<template>\n  <RouterView />\n</template>\n`,
      description: "Replace template with <RouterView /> for vue-router",
    };
  }

  const header = headerHtmlBlock("    ", tailwind);
  return {
    path: appPath,
    type: "modify",
    content: `<script setup>\nimport { Show, SignInButton, SignUpButton, UserButton } from "@clerk/vue";\n</script>\n\n<template>\n${header}\n    <RouterView />\n</template>\n`,
    description: "Replace template with <RouterView /> and add auth header",
  };
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
    const needsRouterBootstrap = ctx.isBootstrap && !ctx.deps["vue-router"];

    const [entryAction, authActions, envAction, routerAction] = await Promise.all([
      scaffoldEntry(ctx, needsRouterBootstrap),
      scaffoldAuthFiles(
        ctx.cwd,
        authFileSpecs({
          path: (kind) => `${base}views/${kind}.vue`,
          content: (kind) => authPageContent(kind, tailwind),
          surface: "page",
        }),
      ),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.vite),
      needsRouterBootstrap ? null : scaffoldRouter(ctx),
    ]);

    const actions: FileAction[] = [entryAction, ...authActions, envAction];
    const postInstructions: string[] = [];
    const additionalDeps: string[] = [];

    if (needsRouterBootstrap) {
      actions.push(scaffoldNewRouter(ctx));
      const appVueAction = await scaffoldAppVue(ctx, tailwind);
      if (appVueAction) actions.push(appVueAction);
      additionalDeps.push("vue-router");
    } else if (routerAction) {
      actions.push(routerAction);
    } else if (ctx.deps["vue-router"]) {
      postInstructions.push(
        "Add sign-in and sign-up routes to your Vue Router config (e.g., `{ path: '/sign-in', component: () => import('./views/sign-in.vue') }`)",
      );
    }

    return { actions, postInstructions, additionalDeps };
  },
};
