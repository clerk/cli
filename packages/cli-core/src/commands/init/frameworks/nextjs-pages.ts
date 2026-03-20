import { join } from "node:path";
import {
  jsxAuthPageContent,
  jsxExt,
  NEXTJS_SIGN_ROUTES_INSTRUCTION,
  safeAddImport,
  scaffoldAuthFiles,
  scaffoldNextjsMiddleware,
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
  return scaffoldAuthFiles(ctx.cwd, [
    {
      path: authPagePath(ctx, "sign-in"),
      content: jsxAuthPageContent("sign-in", "@clerk/nextjs"),
      kind: "sign-in",
      surface: "page",
    },
    {
      path: authPagePath(ctx, "sign-up"),
      content: jsxAuthPageContent("sign-up", "@clerk/nextjs"),
      kind: "sign-up",
      surface: "page",
    },
  ]);
}

export const nextjsPages: FrameworkScaffold = {
  name: "Next.js (Pages Router)",
  dep: "next",
  variant: "pages-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant === "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const [middlewareAction, appAction, authActions] = await Promise.all([
      scaffoldNextjsMiddleware(ctx),
      scaffoldApp(ctx),
      scaffoldAuthPages(ctx),
    ]);

    return {
      actions: [middlewareAction, appAction, ...authActions],
      postInstructions: [NEXTJS_SIGN_ROUTES_INSTRUCTION],
    };
  },
};
