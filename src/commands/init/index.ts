import { login } from "../auth/login.js";
import { link } from "../link/index.js";

const AGENT_PROMPT = `You are integrating Clerk authentication into an existing project. Follow these steps:

1. Install the Clerk SDK appropriate for the project's framework:
   - Next.js: \`@clerk/nextjs\`
   - React: \`@clerk/clerk-react\`
   - Express: \`@clerk/express\`
   - Fastify: \`@clerk/fastify\`
   - Astro: \`@clerk/astro\`
   - Tanstack Start: \`@clerk/tanstack-start\`
   - React Router: \`@clerk/react-router\`
   - Nuxt: \`@clerk/nuxt\`
   - Vue: \`@clerk/vue\`

2. Add the environment variable NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or the equivalent for your framework) and CLERK_SECRET_KEY to the project's .env.local file. The user must provide these values from the Clerk dashboard.

3. Set up the Clerk provider at the root of the application:
   - For Next.js: Wrap the app with \`<ClerkProvider>\` in the root layout.
   - For React: Wrap the app with \`<ClerkProvider publishableKey={key}>\`.
   - For Express/Fastify: Use the \`clerkMiddleware()\` middleware.

4. Add sign-in and sign-up routes/components:
   - Use \`<SignInButton>\` and \`<SignUpButton>\` for trigger buttons.
   - Use \`<SignIn>\` and \`<SignUp>\` for full-page components.
   - Use \`<UserButton>\` to show the signed-in user's avatar and menu.

5. Protect routes that require authentication:
   - Next.js: Use \`clerkMiddleware()\` in \`middleware.ts\` and configure with \`createRouteMatcher\`.
   - React: Use \`<SignedIn>\` and \`<SignedOut>\` components to conditionally render.
   - Express/Fastify: Use \`requireAuth()\` middleware on protected routes.

6. Access the current user:
   - Client-side: \`useUser()\` hook returns the current user object.
   - Server-side (Next.js): \`auth()\` or \`currentUser()\` from \`@clerk/nextjs/server\`.
   - Express/Fastify: \`req.auth\` after applying \`clerkMiddleware()\`.

Refer to the Clerk docs at https://clerk.com/docs for framework-specific details.`;

export async function init(options: { prompt?: boolean }) {
  if (options.prompt) {
    console.log(AGENT_PROMPT);
    return;
  }

  // Step 1: Authenticate the user
  await login();

  // Step 2: Link to a Clerk application
  await link();
}
