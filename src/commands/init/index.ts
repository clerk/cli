import { join } from "node:path";
import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { detectFramework } from "../../lib/framework.js";
import { isAgent } from "../../mode.js";
import { dim, cyan } from "../../lib/color.js";

const AGENT_PROMPT = `You are integrating Clerk authentication into an existing project. Follow these steps:

1. Authenticate with Clerk: Run \`clerk auth login\` to log in via the browser.

2. Link a Clerk application: Run \`clerk link\` to associate this directory with a Clerk application.

3. Install the Clerk SDK appropriate for the project's framework:
   - Next.js: \`@clerk/nextjs\`
   - React: \`@clerk/clerk-react\`
   - Express: \`@clerk/express\`
   - Fastify: \`@clerk/fastify\`
   - Astro: \`@clerk/astro\`
   - Tanstack Start: \`@clerk/tanstack-start\`
   - React Router: \`@clerk/react-router\`
   - Nuxt: \`@clerk/nuxt\`
   - Vue: \`@clerk/vue\`

4. Add the environment variable NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or the equivalent for your framework) and CLERK_SECRET_KEY to the project's .env.local file. You can retrieve these with \`clerk env pull\`.

5. Set up the Clerk provider at the root of the application:
   - For Next.js: Wrap the app with \`<ClerkProvider>\` in the root layout.
   - For React: Wrap the app with \`<ClerkProvider publishableKey={key}>\`.
   - For Express/Fastify: Use the \`clerkMiddleware()\` middleware.

6. Add sign-in and sign-up routes/components:
   - Use \`<SignInButton>\` and \`<SignUpButton>\` for trigger buttons.
   - Use \`<SignIn>\` and \`<SignUp>\` for full-page components.
   - Use \`<UserButton>\` to show the signed-in user's avatar and menu.

7. Protect routes that require authentication:
   - Next.js: Use \`clerkMiddleware()\` in \`middleware.ts\` and configure with \`createRouteMatcher\`.
   - React: Use \`<SignedIn>\` and \`<SignedOut>\` components to conditionally render.
   - Express/Fastify: Use \`requireAuth()\` middleware on protected routes.

8. Access the current user:
   - Client-side: \`useUser()\` hook returns the current user object.
   - Server-side (Next.js): \`auth()\` or \`currentUser()\` from \`@clerk/nextjs/server\`.
   - Express/Fastify: \`req.auth\` after applying \`clerkMiddleware()\`.

Refer to the Clerk docs at https://clerk.com/docs for framework-specific details.`;

async function detectPackageManager(cwd: string): Promise<{ cmd: string; add: string }> {
  const checks: Array<{ files: string[]; cmd: string; add: string }> = [
    { files: ["bun.lockb", "bun.lock"], cmd: "bun", add: "bun add" },
    { files: ["yarn.lock"], cmd: "yarn", add: "yarn add" },
    { files: ["pnpm-lock.yaml"], cmd: "pnpm", add: "pnpm add" },
  ];

  for (const { files, cmd, add } of checks) {
    for (const file of files) {
      if (await Bun.file(join(cwd, file)).exists()) {
        return { cmd, add };
      }
    }
  }

  return { cmd: "npm", add: "npm install" };
}

async function installSdk(cwd: string, sdk: string, frameworkName: string): Promise<void> {
  const pm = await detectPackageManager(cwd);
  console.log(`Installing ${cyan(sdk)} for ${frameworkName}...`);

  const proc = Bun.spawn(pm.add.split(" ").concat(sdk), {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`Failed to install ${sdk}. You can install it manually: ${pm.add} ${sdk}`);
  }
}

export async function init() {
  if (isAgent()) {
    console.log(AGENT_PROMPT);
    return;
  }

  // Step 1: Authenticate the user
  await login();

  // Step 2: Link to a Clerk application
  await link({ skipIfLinked: true });

  const cwd = process.cwd();

  // Step 3: Detect framework and install SDK
  const fw = await detectFramework(cwd);
  if (fw) {
    await installSdk(cwd, fw.sdk, fw.name);
  } else {
    console.log(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: ${dim("https://clerk.com/docs")}`,
    );
  }

  // Step 4: Pull environment variables
  await pull({});
}
