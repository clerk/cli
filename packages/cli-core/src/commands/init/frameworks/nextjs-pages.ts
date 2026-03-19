import { join } from "node:path";
import {
  NEXTJS_SIGN_ROUTES_INSTRUCTION,
  nextjsSignInPageContent,
  nextjsSignUpPageContent,
  safeAddImport,
  scaffoldAuthPage,
  scaffoldNextjsMiddleware,
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
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
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

function signInPath(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
  return `${base}pages/sign-in/[[...sign-in]].${ext}`;
}

function signUpPath(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "tsx" : "jsx";
  return `${base}pages/sign-up/[[...sign-up]].${ext}`;
}

export const nextjsPages: FrameworkScaffold = {
  name: "Next.js (Pages Router)",
  dep: "next",
  variant: "pages-router",
  minMajorVersion: 13,

  enrichContext: enrichNextjsContext,

  matches: (ctx) => ctx.framework.dep === "next" && ctx.variant === "pages-router",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const actions: FileAction[] = [];
    const postInstructions: string[] = [];

    actions.push(await scaffoldNextjsMiddleware(ctx));
    actions.push(await scaffoldApp(ctx));
    actions.push(
      await scaffoldAuthPage(ctx.cwd, signInPath(ctx), nextjsSignInPageContent(), "sign-in page"),
    );
    actions.push(
      await scaffoldAuthPage(ctx.cwd, signUpPath(ctx), nextjsSignUpPageContent(), "sign-up page"),
    );

    postInstructions.push(NEXTJS_SIGN_ROUTES_INSTRUCTION);

    return { actions, postInstructions };
  },
};
