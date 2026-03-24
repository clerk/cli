# Init Command

Initializes Clerk in a project by authenticating the user, linking a Clerk application, installing the SDK, pulling environment variables, and scaffolding framework-specific boilerplate.

## Usage

```sh
clerk init
clerk init --framework next
clerk init --prompt
clerk init -y
clerk init --yes
```

## Options

| Option               | Description                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--framework <name>` | Framework to set up (skips auto-detection). Valid values: `next`, `astro`, `nuxt`, `tanstack-start`, `react-router`, `vue`, `expo`, `react`, `express`, `fastify` |
| `--prompt`           | Output a prompt for an AI agent to integrate Clerk, then exit                                                                                                     |
| `-y, --yes`          | Skip confirmation prompts                                                                                                                                         |

## Agent Mode

When running in agent mode (`--mode agent` or non-TTY), outputs a framework-specific prompt with exact file paths and code snippets, then exits without modifying the project.

## Flow

1. Gathers project context (framework, router variant, TypeScript, `src/` directory, package manager)
2. **Agent mode**: outputs a framework-specific prompt, then exits
3. **Human mode**: authenticates via `clerk auth login` (skipped if already authenticated)
4. Links the project via `clerk link` (skipped if already linked)
5. Displays detected framework and variant
6. Detects existing auth libraries (NextAuth, Auth0, Supabase, Firebase, Passport, Better Auth, Kinde) and shows migration guidance
7. Installs the appropriate Clerk SDK (skips if already present)
8. Pulls development instance API keys via `clerk env pull`
9. Generates a scaffold plan for the detected framework
10. Warns if the git working tree has uncommitted changes
11. Previews planned file changes and asks for confirmation
12. Writes scaffold files to disk
13. Runs project formatters (Prettier/Biome) on generated files
14. Scans for issues: hardcoded keys, leftover auth-library imports, stale API calls
15. Prints a summary of created, modified, and skipped files with recommendations

## Framework Detection

Detects the project's framework from `package.json` dependencies (checked top-to-bottom, first match wins):

| Dependency              | Framework      | Clerk SDK                     | Publishable Key Env Var             |
| ----------------------- | -------------- | ----------------------------- | ----------------------------------- |
| `next`                  | Next.js        | `@clerk/nextjs`               | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `astro`                 | Astro          | `@clerk/astro`                | `PUBLIC_CLERK_PUBLISHABLE_KEY`      |
| `nuxt`                  | Nuxt           | `@clerk/nuxt`                 | `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `@tanstack/react-start` | TanStack Start | `@clerk/tanstack-react-start` | `VITE_CLERK_PUBLISHABLE_KEY`        |
| `react-router`          | React Router   | `@clerk/react-router`         | `VITE_CLERK_PUBLISHABLE_KEY`        |
| `vue`                   | Vue            | `@clerk/vue`                  | `VITE_CLERK_PUBLISHABLE_KEY`        |
| `expo`                  | Expo           | `@clerk/expo`                 | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` |
| `react`                 | React          | `@clerk/react`                | `VITE_CLERK_PUBLISHABLE_KEY`        |
| `express`               | Express        | `@clerk/express`              | `CLERK_PUBLISHABLE_KEY`             |
| `fastify`               | Fastify        | `@clerk/fastify`              | `CLERK_PUBLISHABLE_KEY`             |

Package manager is detected from lock files: `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

## Scaffolding

Scaffolding is supported for the first 8 frameworks above. Expo, Express, and Fastify are detected (SDK is installed, env vars are pulled) but scaffolding is not yet supported — users are directed to the Clerk docs.

All scaffolding is idempotent — files are skipped if they already contain Clerk setup.

### Next.js (App Router)

| Action | File                                  | Description                                           |
| ------ | ------------------------------------- | ----------------------------------------------------- |
| CREATE | `proxy.ts` or `middleware.ts`         | `clerkMiddleware` with route protection               |
| MODIFY | `app/layout.tsx`                      | Add `ClerkProvider` import and wrap `<body>` children |
| CREATE | `app/sign-in/[[...sign-in]]/page.tsx` | Sign-in page with `<SignIn />` component              |
| CREATE | `app/sign-up/[[...sign-up]]/page.tsx` | Sign-up page with `<SignUp />` component              |

The middleware filename is version-aware: `proxy.ts` for Next.js 16+, `middleware.ts` for ≤15. Existing middleware files are preserved and composed with `clerkMiddleware`.

### Next.js (Pages Router)

| Action        | File                               | Description                              |
| ------------- | ---------------------------------- | ---------------------------------------- |
| CREATE        | `proxy.ts` or `middleware.ts`      | `clerkMiddleware` with route protection  |
| CREATE/MODIFY | `pages/_app.tsx`                   | `ClerkProvider` wrapping `<Component>`   |
| CREATE        | `pages/sign-in/[[...sign-in]].tsx` | Sign-in page with `<SignIn />` component |
| CREATE        | `pages/sign-up/[[...sign-up]].tsx` | Sign-up page with `<SignUp />` component |

### React / Vite

| Action | File       | Description                                  |
| ------ | ---------- | -------------------------------------------- |
| MODIFY | `main.tsx` | Add `ClerkProvider` import and wrap app root |

### React Router

| Action | File                     | Description                                            |
| ------ | ------------------------ | ------------------------------------------------------ |
| MODIFY | `react-router.config.ts` | Enable `v8_middleware` future flag                     |
| MODIFY | `app/root.tsx`           | Add ClerkProvider, clerkMiddleware, and rootAuthLoader |
| CREATE | `app/routes/sign-in.tsx` | Sign-in route with `<SignIn />` component              |
| CREATE | `app/routes/sign-up.tsx` | Sign-up route with `<SignUp />` component              |

### Nuxt

| Action | File                | Description                              |
| ------ | ------------------- | ---------------------------------------- |
| MODIFY | `nuxt.config.ts`    | Add `@clerk/nuxt` to modules array       |
| CREATE | `pages/sign-in.vue` | Sign-in page with `<SignIn />` component |
| CREATE | `pages/sign-up.vue` | Sign-up page with `<SignUp />` component |

Nuxt's module system auto-configures middleware and auto-imports components.

### TanStack Start

| Action | File                       | Description                                 |
| ------ | -------------------------- | ------------------------------------------- |
| MODIFY | `src/start.ts`             | Add `clerkMiddleware` to request middleware |
| MODIFY | `src/routes/__root.tsx`    | Add `ClerkProvider` and wrap body contents  |
| CREATE | `src/routes/sign-in.$.tsx` | Sign-in route with `<SignIn />` component   |
| CREATE | `src/routes/sign-up.$.tsx` | Sign-up route with `<SignUp />` component   |

### Astro

| Action | File                      | Description                                 |
| ------ | ------------------------- | ------------------------------------------- |
| MODIFY | `astro.config.mjs`        | Add `clerk()` integration import and config |
| CREATE | `src/middleware.ts`       | Clerk middleware with `onRequest` export    |
| CREATE | `src/pages/sign-in.astro` | Sign-in page with `<SignIn />` component    |
| CREATE | `src/pages/sign-up.astro` | Sign-up page with `<SignUp />` component    |

### Vue

| Action | File      | Description                                        |
| ------ | --------- | -------------------------------------------------- |
| MODIFY | `main.ts` | Add `clerkPlugin` with `publishableKey` to Vue app |

## API Endpoints

See [auth/README.md](../auth/README.md), [link/README.md](../link/README.md), and [env/README.md](../env/README.md) for the API endpoints used by each step.
