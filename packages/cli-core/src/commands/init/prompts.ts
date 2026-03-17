import type { ProjectContext } from "./frameworks/types.js";

type PromptBuilder = (ctx: ProjectContext, base: string, ext: string, jsx: string) => string;

function nextjsAppRouterPrompt(
  ctx: ProjectContext,
  base: string,
  ext: string,
  jsx: string,
): string {
  return `Integrate Clerk auth into this Next.js (App Router) project.

1. Install: ${ctx.framework.sdk}
2. Create ${base}${ctx.middlewareBasename}.${ext}:
   \`\`\`typescript
   import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
   const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);
   export default clerkMiddleware(async (auth, request) => {
     if (!isPublicRoute(request)) { await auth.protect(); }
   });
   export const config = { matcher: ["/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"] };
   \`\`\`
3. Modify ${ctx.layoutPath ?? `${base}app/layout.${jsx}`}: Add \`import { ClerkProvider } from "@clerk/nextjs"\` and wrap the body children with \`<ClerkProvider>...</ClerkProvider>\`.
4. Create ${base}app/sign-in/[[...sign-in]]/page.${jsx}: \`import { SignIn } from "@clerk/nextjs"; export default function SignInPage() { return <SignIn />; }\`
5. Create ${base}app/sign-up/[[...sign-up]]/page.${jsx}: \`import { SignUp } from "@clerk/nextjs"; export default function SignUpPage() { return <SignUp />; }\`
6. Add to .env.local: NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
7. Env vars (${ctx.framework.envVar} and CLERK_SECRET_KEY) are in .env.local via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/nextjs`;
}

function nextjsPagesRouterPrompt(
  ctx: ProjectContext,
  base: string,
  ext: string,
  jsx: string,
): string {
  return `Integrate Clerk auth into this Next.js (Pages Router) project.

1. Install: ${ctx.framework.sdk}
2. Create ${base}${ctx.middlewareBasename}.${ext}: Same as App Router (clerkMiddleware with createRouteMatcher).
3. Create or modify ${base}pages/_app.${jsx}: Wrap \`<Component {...pageProps} />\` with \`<ClerkProvider {...pageProps}>...</ClerkProvider>\`.
4. Create ${base}pages/sign-in/[[...sign-in]].${jsx}: \`import { SignIn } from "@clerk/nextjs"; export default function SignInPage() { return <SignIn />; }\`
5. Create ${base}pages/sign-up/[[...sign-up]].${jsx}: \`import { SignUp } from "@clerk/nextjs"; export default function SignUpPage() { return <SignUp />; }\`
6. Add to .env.local: NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up

Docs: https://clerk.com/docs/quickstarts/nextjs`;
}

const AGENT_PROMPTS: Record<string, PromptBuilder> = {
  react: (ctx, base, _ext, jsx) => `Integrate Clerk auth into this React project.

1. Install: ${ctx.framework.sdk}
2. Modify ${base}main.${jsx} (or entry file): Add \`import { ClerkProvider } from "@clerk/react"\` and wrap the app root with \`<ClerkProvider afterSignOutUrl="/">...<App />...</ClerkProvider>\`.
3. Use \`<SignInButton />\`, \`<SignUpButton />\`, \`<UserButton />\` from @clerk/react in your components.
4. Use \`<Show when="signed-in">\` and \`<Show when="signed-out">\` from @clerk/react for conditional rendering.
5. Env var (${ctx.framework.envVar}) is in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/react`,

  "react-router": (ctx, _base, _ext, jsx) => `Integrate Clerk auth into this React Router project.

1. Install: ${ctx.framework.sdk}
2. Enable middleware in react-router.config.ts: Add \`future: { v8_middleware: true }\` to the config.
3. Modify app/root.tsx:
   - Add \`import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server"\`
   - Add \`import { ClerkProvider } from "@clerk/react-router"\`
   - Export \`const middleware: Route.MiddlewareFunction[] = [clerkMiddleware()]\`
   - Export \`const loader = (args: Route.LoaderArgs) => rootAuthLoader(args)\`
   - Wrap content with \`<ClerkProvider loaderData={loaderData}>...</ClerkProvider>\`
4. Create app/routes/sign-in.${jsx}: \`import { SignIn } from "@clerk/react-router"; export default function SignInPage() { return <SignIn />; }\`
5. Create app/routes/sign-up.${jsx}: \`import { SignUp } from "@clerk/react-router"; export default function SignUpPage() { return <SignUp />; }\`
6. Add routes to app/routes.ts: \`route('sign-in/*', 'routes/sign-in.tsx')\` and \`route('sign-up/*', 'routes/sign-up.tsx')\`
7. Env vars (${ctx.framework.envVar} and CLERK_SECRET_KEY) are in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/react-router`,

  nuxt: (ctx) => `Integrate Clerk auth into this Nuxt project.

1. Install: ${ctx.framework.sdk}
2. Modify nuxt.config.ts: Add \`'@clerk/nuxt'\` to the \`modules\` array. Middleware is auto-configured.
3. Create pages/sign-in.vue: \`<template><SignIn /></template>\` (components are auto-imported).
4. Create pages/sign-up.vue: \`<template><SignUp /></template>\`.
5. Use \`<Show when="signed-in">\` and \`<Show when="signed-out">\` in your templates for conditional rendering.
6. Env vars (${ctx.framework.envVar} and NUXT_CLERK_SECRET_KEY) are in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/nuxt`,

  "@tanstack/react-start": (ctx, _base, _ext, jsx) =>
    `Integrate Clerk auth into this TanStack Start project.

1. Install: ${ctx.framework.sdk}
2. Modify src/start.ts: Add \`import { clerkMiddleware } from "@clerk/tanstack-react-start/server"\` and add \`requestMiddleware: [clerkMiddleware()]\` to createStart config.
3. Modify src/routes/__root.tsx: Add \`import { ClerkProvider } from "@clerk/tanstack-react-start"\` and wrap body contents with \`<ClerkProvider>\`.
4. Create src/routes/sign-in.$.${jsx}: Use \`createFileRoute("/sign-in/$")\` with \`<SignIn />\` from @clerk/tanstack-react-start.
5. Create src/routes/sign-up.$.${jsx}: Use \`createFileRoute("/sign-up/$")\` with \`<SignUp />\`.
6. Env vars (${ctx.framework.envVar} and CLERK_SECRET_KEY) are in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/tanstack-start`,

  astro: (ctx) => `Integrate Clerk auth into this Astro project.

1. Install: ${ctx.framework.sdk}
2. Modify astro.config.mjs: Add \`import clerk from "@clerk/astro"\` and \`clerk()\` to integrations. Ensure \`output: "server"\` and an SSR adapter.
3. Create src/middleware.ts: \`import { clerkMiddleware } from "@clerk/astro/server"; export const onRequest = clerkMiddleware();\`
4. Create src/pages/sign-in.astro with \`<SignIn />\` from @clerk/astro/components.
5. Create src/pages/sign-up.astro with \`<SignUp />\` from @clerk/astro/components.
6. Use \`<Show when="signed-in">\` and \`<Show when="signed-out">\` from @clerk/astro/components in layouts.
7. Env vars (${ctx.framework.envVar} and CLERK_SECRET_KEY) are in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/astro`,

  vue: (ctx, base) => `Integrate Clerk auth into this Vue project.

1. Install: ${ctx.framework.sdk}
2. Modify ${base}main.ts: Add \`import { clerkPlugin } from "@clerk/vue"\` and \`app.use(clerkPlugin, { publishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY })\`.
3. Use \`<Show>\`, \`<SignInButton>\`, \`<SignUpButton>\`, \`<UserButton>\` from @clerk/vue in components.
4. Env var (${ctx.framework.envVar}) is in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs/quickstarts/vue`,
};

export const GENERIC_AGENT_PROMPT = `You are integrating Clerk authentication into an existing project. Follow these steps:

1. Authenticate with Clerk: Run \`clerk auth login\` to log in via the browser.
2. Link a Clerk application: Run \`clerk link\` to associate this directory with a Clerk application.
3. Install the Clerk SDK appropriate for the project's framework (see https://clerk.com/docs/quickstarts).
4. Pull environment variables with \`clerk env pull\`.
5. Set up the Clerk provider at the root of the application.
6. Add sign-in and sign-up routes/components.
7. Protect routes that require authentication.

Refer to the Clerk docs at https://clerk.com/docs for framework-specific details.`;

export function buildAgentPrompt(ctx: ProjectContext): string {
  const base = ctx.srcDir ? "src/" : "";
  const ext = ctx.typescript ? "ts" : "js";
  const jsx = ctx.typescript ? "tsx" : "jsx";

  if (ctx.framework.dep === "next") {
    if (ctx.variant === "pages-router") {
      return nextjsPagesRouterPrompt(ctx, base, ext, jsx);
    }
    return nextjsAppRouterPrompt(ctx, base, ext, jsx);
  }

  const builder = AGENT_PROMPTS[ctx.framework.dep];
  if (builder) {
    return builder(ctx, base, ext, jsx);
  }

  return `Integrate Clerk auth into this ${ctx.framework.name} project.

1. Install: ${ctx.framework.sdk}
2. Set up the Clerk provider/middleware for ${ctx.framework.name}.
3. Create sign-in and sign-up routes/components.
4. Env vars (${ctx.framework.envVar} and CLERK_SECRET_KEY) are in ${ctx.envFile} via \`clerk env pull\`.

Docs: https://clerk.com/docs`;
}
