import { join } from "node:path";
import {
  authFileSpecs,
  hasTailwindStyles,
  jsxAuthPageContent,
  jsxExt,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldEnvVars,
  scaffoldNextjsMiddleware,
  SIGN_ROUTE_ENV_VARS,
  srcPrefix,
} from "./helpers.js";
import { enrichNextjsContext } from "./nextjs-context.js";
import type { FileAction, FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

function appWrapperContent(typescript: boolean): string {
  if (typescript) {
    return `import { ClerkProvider } from "@clerk/nextjs";
import type { AppProps } from "next/app";

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ClerkProvider {...pageProps}>
      <Component {...pageProps} />
    </ClerkProvider>
  );
}
`;
  }

  return `import { ClerkProvider } from "@clerk/nextjs";

export default function MyApp({ Component, pageProps }) {
  return (
    <ClerkProvider {...pageProps}>
      <Component {...pageProps} />
    </ClerkProvider>
  );
}
`;
}

async function scaffoldApp(ctx: ProjectContext): Promise<FileAction> {
  const base = srcPrefix(ctx);
  const ext = jsxExt(ctx);
  const path = `${base}pages/_app.${ext}`;
  const file = Bun.file(join(ctx.cwd, path));

  if (!(await file.exists())) {
    return {
      path,
      type: "create",
      content: appWrapperContent(ctx.typescript),
      description: "Create _app with ClerkProvider wrapper",
    };
  }

  const content = await file.text();

  if (content.includes("ClerkProvider")) {
    return { type: "skip", path, skipReason: "Already has ClerkProvider" };
  }

  let newContent = safeAddImport(content, "@clerk/nextjs", "ClerkProvider");

  if (newContent.includes("<Component")) {
    newContent = newContent.replace(
      /(<Component\s[^/]*\/>)/,
      "<ClerkProvider {...pageProps}>\n      $1\n    </ClerkProvider>",
    );
  }

  return {
    path,
    type: "modify",
    content: newContent,
    description: "Add ClerkProvider import and wrap Component",
  };
}

function authPagePath(ctx: ProjectContext, kind: "sign-in" | "sign-up"): string {
  return `${srcPrefix(ctx)}pages/${kind}/[[...${kind}]].${jsxExt(ctx)}`;
}

async function scaffoldAuthPages(ctx: ProjectContext): Promise<FileAction[]> {
  const tailwind = hasTailwindStyles(ctx);
  return scaffoldAuthFiles(
    ctx.cwd,
    authFileSpecs({
      path: (kind) => authPagePath(ctx, kind),
      content: (kind) => jsxAuthPageContent(kind, "@clerk/nextjs", tailwind),
      surface: "page",
    }),
  );
}

export const nextjsPages: FrameworkScaffold = {
  name: "Next.js (Pages Router)",
  dep: "next",
  variant: "pages-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant === "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [middlewareAction, appAction, authActions, envAction] = await Promise.all([
      scaffoldNextjsMiddleware(ctx),
      scaffoldApp(ctx),
      scaffoldAuthPages(ctx),
      scaffoldEnvVars(ctx, SIGN_ROUTE_ENV_VARS.nextjs),
    ]);

    const postInstructions: string[] = [
      "Routes are public by default — protect pages and API routes individually with `getAuth()`. See: https://clerk.com/docs/reference/nextjs/pages-router/get-auth",
    ];

    const hasI18n = Boolean(ctx.deps["next-intl"] || ctx.deps["next-i18next"]);
    if (hasI18n) {
      postInstructions.push(
        "Next.js Pages Router handles i18n routing automatically via next.config.js — no additional page placement needed for sign-in/sign-up",
      );
    }

    return {
      actions: [middlewareAction, appAction, ...authActions, envAction],
      postInstructions,
    };
  },
};
