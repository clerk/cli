# Init Command

Initializes Clerk in a project by authenticating the user, linking a Clerk application, installing the SDK, pulling environment variables, and scaffolding framework-specific boilerplate.

## Usage

```sh
clerk init
clerk init --app app_123
clerk init --framework next
clerk init --starter
clerk init --starter --framework next --pm bun
clerk init --starter --framework next --pm bun --name my-app
clerk init --prompt
clerk init -y
clerk init --yes
clerk init --no-skills
```

## Options

| Option                  | Description                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--framework <name>`    | Framework to set up (skips auto-detection). Valid values: `next`, `astro`, `nuxt`, `tanstack-start`, `react-router`, `vue`, `expo`, `react`, `javascript`, `js`, `express`, `fastify` |
| `--pm <manager>`        | Package manager to use. Valid values: `bun`, `pnpm`, `yarn`, `npm`. Skips the PM prompt (bootstrap) or overrides lockfile detection (existing project)                                |
| `--name <project-name>` | Project name for `--starter` (skips prompt). Must be lowercase, no spaces, no path separators                                                                                         |
| `--app <id>`            | Application ID to link (skips the interactive app picker during authenticated linking)                                                                                                |
| `--starter`             | Bootstrap a new project from a starter template (runs the framework generator, installs deps, and scaffolds Clerk)                                                                    |
| `--prompt`              | Output a prompt for an AI agent to integrate Clerk, then exit                                                                                                                         |
| `-y, --yes`             | Skip confirmation prompts (also skips authentication after bootstrap, letting you connect your account later)                                                                         |
| `--no-skills`           | Skip the optional agent skills install prompt at the end of init                                                                                                                      |

## Agent Mode

When running in agent mode (`--mode agent` or non-TTY), the command runs the full init flow non-interactively:

- All confirmation prompts are auto-skipped (as if `--yes` was passed)
- For **existing projects**: framework and package manager are auto-detected, no flags required
- For **new projects** (`--starter` or blank directory): `--framework` is required (no way to auto-detect in an empty dir). Package manager is auto-selected by availability (bun → pnpm → yarn → npm) unless `--pm` is provided
- Project name defaults to the framework's default (e.g. `my-clerk-next-app`) unless `--name` is provided

Use `--prompt` to output a setup prompt for an AI agent without running init.

## Flow

1. **`--prompt`**: outputs a framework-specific prompt, then exits
2. Gathers project context (framework, router variant, TypeScript, `src/` directory, package manager)
3. **Human mode**: determines auth mode:
   - If already authenticated and linked: uses authenticated mode automatically
   - If authenticated but not linked: uses authenticated mode (runs `clerk link`)
   - If not authenticated: asks user — "Continue with temporary keys (connect your account later)" or "Log in to an existing Clerk account"
   - With `--yes` and not authenticated: skips authentication (connect your account later), including for non-keyless frameworks during bootstrap
4. **Authenticated mode only**: authenticates via `clerk auth login` (skipped if already authenticated) and links the project via `clerk link` (skipped if already linked)
5. Displays detected framework and variant
6. Detects existing auth libraries (NextAuth, Auth0, Supabase, Firebase, Passport, Better Auth, Kinde) and shows migration guidance
7. Installs the appropriate Clerk SDK (skips if already present)
8. Generates a scaffold plan for the detected framework
9. Warns if the git working tree has uncommitted changes
10. Previews planned file changes and asks for confirmation
11. Writes scaffold files to disk
12. Runs project formatters (Prettier/Biome) on generated files
13. Scans for issues: hardcoded keys, leftover auth-library imports, stale API calls
14. Prints a summary of created, modified, and skipped files with recommendations
15. **Authenticated mode**: pulls development instance API keys via `clerk env pull`
16. **Unauthenticated mode**: prints instructions for development without API keys and how to connect a Clerk account later
17. Optionally installs framework-specific Clerk agent skills via the project's package runner (see [Agent skills install](#agent-skills-install))

## Framework Detection

Detects the project's framework from `package.json` dependencies (checked top-to-bottom, first match wins):

| Dependency              | Framework      | Clerk SDK                     | Publishable Key Env Var             | Keyless |
| ----------------------- | -------------- | ----------------------------- | ----------------------------------- | ------- |
| `next`                  | Next.js        | `@clerk/nextjs`               | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes     |
| `astro`                 | Astro          | `@clerk/astro`                | `PUBLIC_CLERK_PUBLISHABLE_KEY`      | Yes     |
| `nuxt`                  | Nuxt           | `@clerk/nuxt`                 | `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes     |
| `@tanstack/react-start` | TanStack Start | `@clerk/tanstack-react-start` | `VITE_CLERK_PUBLISHABLE_KEY`        | Yes     |
| `react-router`          | React Router   | `@clerk/react-router`         | `VITE_CLERK_PUBLISHABLE_KEY`        | Yes     |
| `vue`                   | Vue            | `@clerk/vue`                  | `VITE_CLERK_PUBLISHABLE_KEY`        | No      |
| `expo`                  | Expo           | `@clerk/expo`                 | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | No      |
| `react`                 | React          | `@clerk/react`                | `VITE_CLERK_PUBLISHABLE_KEY`        | No      |
| `vite`                  | JavaScript     | `@clerk/clerk-js`             | `VITE_CLERK_PUBLISHABLE_KEY`        | No      |
| `express`               | Express        | `@clerk/express`              | `CLERK_PUBLISHABLE_KEY`             | No      |
| `fastify`               | Fastify        | `@clerk/fastify`              | `CLERK_PUBLISHABLE_KEY`             | No      |

The **Keyless** column indicates whether the framework's Clerk SDK supports keyless mode (auto-generated temporary dev keys). Frameworks without keyless support require API keys and always force authentication during `clerk init`, even with `--yes`.

Package manager is detected from lock files: `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

## Scaffolding

Scaffolding is supported for the first 9 frameworks above (through JavaScript/Vite). Expo, Express, and Fastify are detected (SDK is installed, env vars are pulled) but scaffolding is not yet supported — users are directed to the Clerk docs.

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

| Action | File                                | Description                                               |
| ------ | ----------------------------------- | --------------------------------------------------------- |
| MODIFY | `nuxt.config.ts`                    | Add `@clerk/nuxt` to modules array                        |
| MODIFY | `app/app.vue` or `app.vue`          | Replace `<NuxtWelcome />` with `<NuxtPage />` (if needed) |
| CREATE | `[app/]pages/sign-in/[...slug].vue` | Sign-in page with `<SignIn />` component                  |
| CREATE | `[app/]pages/sign-up/[...slug].vue` | Sign-up page with `<SignUp />` component                  |

The pages directory is `app/pages/` for Nuxt 4 projects (which use `app/` as the default srcDir) and `pages/` for Nuxt 3 projects. Catch-all routes (`[...slug].vue`) are used so Clerk can handle sign-in sub-paths such as `/sign-in/factor-one`.

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

| Action        | File                    | Description                                        |
| ------------- | ----------------------- | -------------------------------------------------- |
| CREATE/MODIFY | `main.ts`               | Add `clerkPlugin` with `publishableKey` to Vue app |
| CREATE        | `src/views/sign-in.vue` | Sign-in page with `<SignIn />` component           |
| CREATE        | `src/views/sign-up.vue` | Sign-up page with `<SignUp />` component           |
| MODIFY        | `src/router/index.ts`   | Add sign-in and sign-up routes (if router exists)  |
| MODIFY        | `.env`                  | Add sign-in/sign-up route env vars (VITE\_ prefix) |

**Bootstrap (new project)**: When scaffolding a new Vue project via `--starter` or blank directory, `vue-router` is installed and a router config is created with sign-in/sign-up routes. `App.vue` is updated to use `<RouterView />`.

### JavaScript (Vite)

| Action | File             | Description                                     |
| ------ | ---------------- | ----------------------------------------------- |
| MODIFY | `src/main.ts/js` | Replace entry file with Clerk JS initialization |

If no entry file is found, a post-instruction is printed pointing to the Clerk JS quickstart.

## Agent skills install

After scaffolding (and after env keys are pulled or keyless instructions are printed), `clerk init` offers to install Clerk's agent skills via the [`skills`](https://www.npmjs.com/package/skills) CLI. The runner is detected from the project's package manager (`bunx`, `npx`, `pnpm dlx`, or `yarn dlx`), so a Bun project installs via `bunx skills add ...`, a pnpm project via `pnpm dlx skills add ...`, and so on. This step is optional and non-fatal: if no package runner is available on PATH or an install command exits non-zero, init prints a yellow warning with a runner-appropriate manual command and still exits successfully.

- **Human mode**: prompts `Install agent skills? (...)` defaulting to yes. Pass `--no-skills` to suppress the prompt entirely, or `-y/--yes` to accept it without confirmation. When more than one runner is available, a second prompt picks which one to use (the project's package manager wins by default).
- **Agent mode**: skills are installed non-interactively with `-y -g` flags (no prompt shown). Pass `--no-skills` to skip entirely.
- **`--prompt`**: exits before the skills step runs. Agent users should run `skills add clerk/skills` via their preferred runner manually; the bundled `clerk` skill is only installable via `clerk init` itself, since its source lives inside the CLI binary.

Two install commands run, sharing one runner:

### 1. The bundled `clerk` skill

The `clerk` skill ships **inside the CLI binary**. Its markdown files at [`<repo-root>/skills/clerk/`](../../../../../skills/clerk/) are pulled into [`skills.ts`](./skills.ts) as [text imports](https://bun.com/docs/bundler/loaders#text) (`import md from "./SKILL.md" with { type: "text" }`) and embedded by `bun build --compile`, so the skill content always matches the binary running it. No network, no tag, no version fallback.

At install time, [`skills.ts`](./skills.ts) stages the bundled content into a fresh temp directory (`mkdtemp`) and invokes `<runner> skills add <tmpdir> --copy`. The `--copy` flag is required: the default symlink mode would point each agent's skill dir at the temp dir, which we delete immediately after the install completes.

The `skills` CLI writes the installed files into each agent's skill directory (`.claude/skills/clerk/`, `.cursor/skills/clerk/`, etc.) and records the entry in the project's `skills-lock.json` with `sourceType: "local"`, which correctly excludes it from `skills update` (the skill can only change when the CLI itself is upgraded).

### 2. The upstream framework-pattern skills

The base skills `clerk` and `clerk-setup` are always included from [`clerk/skills`](https://github.com/clerk/skills). The detected framework dependency adds a matching skill:

| Framework dep           | Added skill                   |
| ----------------------- | ----------------------------- |
| `next`                  | `clerk-nextjs-patterns`       |
| `react`                 | `clerk-react-patterns`        |
| `react-router`          | `clerk-react-router-patterns` |
| `vue`                   | `clerk-vue-patterns`          |
| `nuxt`                  | `clerk-nuxt-patterns`         |
| `astro`                 | `clerk-astro-patterns`        |
| `@tanstack/react-start` | `clerk-tanstack-patterns`     |
| `expo`                  | `clerk-expo-patterns`         |
| `express`               | `clerk-backend-api`           |
| `fastify`               | `clerk-backend-api`           |

These skills version independently of the CLI, so no pin is applied.

### Failure handling

The two install commands fail independently: a problem with the bundled `clerk` skill install (e.g. the `skills` CLI can't be fetched by the runner) does not block the upstream skills install, and vice versa. Each failure prints its own yellow warning with a manual install command (where applicable — the bundled `clerk` skill has no standalone manual command, since its source lives in the binary). Init continues and exits successfully either way.

Implementation lives in [`skills.ts`](./skills.ts). Note that the E2E fixture setup runs `clerk init --yes --no-skills` because the framework template skills reference auto-generated types (e.g. React Router's `./+types/root`) that don't exist outside a real app directory and would break the fixture's `tsc` step.

## API Endpoints

See [auth/README.md](../auth/README.md), [link/README.md](../link/README.md), and [env/README.md](../env/README.md) for the API endpoints used by each step.
