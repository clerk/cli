# Init Command

Initializes Clerk in a project by detecting the framework, installing the SDK, and scaffolding framework-specific boilerplate. When the user is unauthenticated and the framework supports accountless, init defaults to accountless mode — auto-generated temporary development keys that a later `clerk auth login` claims automatically — during bootstrap (new projects) in human mode and in all agent-mode runs. Otherwise init logs the user in (interactively) and links a real Clerk application. `--accountless` forces accountless (even when logged in); `--login` forces the authenticated flow.

## Usage

```sh
clerk init
clerk init --app app_123
clerk init --framework next
clerk init --starter
clerk init --starter --framework next --pm bun
clerk init --starter --framework next --pm bun --name my-app
clerk init --starter --framework next --accountless
clerk init --login
clerk init --template b2b-saas
clerk init --accountless --fresh
clerk init -y
clerk init --yes
clerk init --no-skills
clerk init --target MyApp
clerk init --target MyApp --yes
clerk init --app app_123 --target MyApp --sdk core --yes
clerk init --target MyApp --prebuilt-auth-ui
clerk init --target MyApp --sign-in-with-apple
clerk init --dry-run
clerk init --dry-run --target MyApp
clerk init --dry-run --target MyApp --json
```

## Options

| Option                   | Description                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--framework <name>`     | Framework to set up (skips auto-detection). Valid values: `next`, `astro`, `nuxt`, `tanstack-start`, `react-router`, `vue`, `expo`, `react`, `javascript`, `js`, `express`, `fastify`, `ios`, `android`                                                            |
| `--pm <manager>`         | Package manager to use. Valid values: `bun`, `pnpm`, `yarn`, `npm`. Skips the PM prompt (bootstrap) or overrides lockfile detection (existing project)                                                                                                             |
| `--name <project-name>`  | Project name for `--starter` (skips prompt). Must be lowercase, no spaces, no path separators                                                                                                                                                                      |
| `--app <id>`             | Application ID to link (skips the interactive app picker during authenticated linking)                                                                                                                                                                             |
| `--starter`              | Bootstrap a new project from a starter template (runs the framework generator, installs deps, and scaffolds Clerk)                                                                                                                                                 |
| `--accountless`          | Force auto-generated temporary development keys, even when logged in. Only valid on an accountless-capable framework; cannot be combined with `--login` or `--app`                                                                                                 |
| `--login`                | Force the authenticated flow: log in (interactively if needed) and link a real application instead of accountless keys. Opens browser login when authentication is needed, including in agent mode                                                                 |
| `--template <name>`      | Pre-configure the accountless application at creation: `b2b-saas`, `b2c-saas`, `native`, `waitlist`. Only applies when the run resolves to accountless — errors otherwise (see [Application templates](#application-templates)); cannot be combined with `--login` |
| `--fresh`                | Replace an existing unclaimed accountless application with a new one, instead of keeping it (see [Accountless breadcrumb](#accountless-breadcrumb)). Only applies when the run resolves to accountless — errors otherwise; cannot be combined with `--login`       |
| `--dry-run`              | Inspect an existing native Apple (iOS or macOS) project and print a semantic Clerk setup plan without changing local or remote state                                                                                                                               |
| `--json`                 | Output native setup results and the agent handoff, or a read-only inspection with `--dry-run`                                                                                                                                                                      |
| `--target <name-or-id>`  | Select a native Apple application target by target name or PBX object ID for either inspection or setup                                                                                                                                                            |
| `--project <path>`       | Select an Xcode project or workspace                                                                                                                                                                                                                               |
| `--configuration <name>` | Select a custom build configuration                                                                                                                                                                                                                                |
| `--bundle-id <id>`       | Confirm an ambiguous Bundle ID                                                                                                                                                                                                                                     |
| `--app-id-prefix <id>`   | Apple App ID Prefix to use if the selected native Apple Bundle ID needs a new Clerk registration. Never inferred from `DEVELOPMENT_TEAM`; required in agent mode when local/remote evidence cannot supply it                                                       |
| `--sign-in-with-apple`   | Opt into native Sign in with Apple for the selected native Apple target. Adds the exact Apple entitlement and enables the matching native Clerk connection; never requests hosted/web Apple credentials                                                            |
| `--prebuilt-auth-ui`     | Opt into ClerkKitUI's prebuilt authentication UI for an untouched, safely inspectable SwiftUI starter. Existing or customized application UI is preserved and returned for review instead of being rewritten                                                       |
| `--sdk <products>`       | Choose native Apple products: `core` for ClerkKit or `ui` for ClerkKit and ClerkKitUI. Preserves existing products and does not insert AuthView                                                                                                                    |
| `-y, --yes`              | Skip y/n confirmation prompts only. It neither forces nor bypasses accountless — the strategy is picked by auth state, mode, and flags. It does **not** replace an existing unclaimed accountless app — that still requires `--fresh`                              |
| `--no-skills`            | Skip the optional agent skills install prompt at the end of init                                                                                                                                                                                                   |

`--keyless` remains accepted as a deprecated, hidden compatibility alias for `--accountless`. Use `--accountless` in all new commands and documentation.

## Native Apple setup and inspection

Run `clerk init` from an iOS or macOS project directory for the full interactive
flow. The CLI discovers projects/workspaces and targets, authenticates and links
a Clerk app, discovers the Bundle ID and an existing App ID Prefix, and previews
local and remote setup. It installs and downloads the Swift packages, configures
capabilities, registers the native identity, and optionally enables Apple sign-in.
Debug and Release are covered by default; `--configuration` selects custom builds.

Both `project.pbxproj` and `project.xcproj` are supported. Xcode is required. The
CLI preserves existing package policy and products, and asks a custom app to choose
products when none are installed. New noninteractive setups default to both
ClerkKit and ClerkKitUI; `--sdk core` selects core alone.

An unchanged SwiftUI starter can receive direct Clerk configuration, environment
injection, and explicitly requested prebuilt UI. Custom Swift is preserved and
handed to the developer or calling agent. Human output summarizes completed work
and links to the quickstart. No ClerkProvider or wrapper view is introduced.

An explicit `--project` selects native Apple setup, including nested projects or
workspaces in repositories whose root has no framework marker or contains a web app.
Bundle ID capitalization must match the existing Clerk registration; a mismatch
stops setup before applying edits and reports both values for correction.
On macOS, sandbox networking is configured whether sandboxing comes from Xcode
build settings or the selected entitlement file.

`--dry-run --json` uses Xcode for inspection but does not authenticate, fetch Clerk
settings, apply setup, or initiate package resolution. If unresolved dependencies
prevent inspection, run normal init to resolve them. Normal agent/JSON apply
requires `--yes`, existing authentication, and `--app` or an existing project link.
Its structured handoff includes the development publishable key and explicitly
pending source/build tasks. Preview output redacts keys.

See [the native setup contract](../../../../../docs/native-established-apps.md)
for capability scope, Apple identity discovery, recovery, and verification limits.

## Agent Mode

When running in agent mode (`--mode agent` or non-TTY), the command runs the full init flow non-interactively:

- Confirmation prompts are generally auto-skipped, but changing a native Apple Xcode project requires an explicit `--yes`
- Native Apple remote mutations also require explicit `--yes`; when no existing registration or complete literal evidence supplies the App ID Prefix, pass `--app-id-prefix`
- New native Apple setups default to both SDK products in agent mode; `--sdk core` selects ClerkKit alone
- Native Sign in with Apple additionally requires `--sign-in-with-apple`; `--yes` grants mutation consent but never opts a project into an authentication strategy
- The prebuilt native Apple authentication UI additionally requires `--prebuilt-auth-ui`; `--yes` and agent mode never opt into replacing even an eligible starter screen
- `init --dry-run` automatically emits structured JSON, even when `--json` is omitted
- For **existing projects**: framework and package manager are auto-detected, no flags required
- For **new projects** (`--starter` or blank directory): `--framework` is required (no way to auto-detect in an empty dir). Package manager is auto-selected by availability (bun → pnpm → yarn → npm) unless `--pm` is provided
- Project name defaults to the framework's default (e.g. `my-clerk-next-app`) unless `--name` is provided
- For accountless-capable frameworks with no `--app` and no linked profile:
  - When **authenticated**, init creates a real Clerk app named after the project (`package.json#name`, `--name`, or directory basename) and links it.
  - When **unauthenticated**, init uses accountless: the app runs on auto-generated dev keys, and init writes a legacy-named `.clerk/keyless.json` breadcrumb so the next `clerk auth login` claims the app automatically.
- Native Apple agent setup reuses an existing link or `--app <id>`. Otherwise it authenticates, then guides the agent to use `clerk apps list --json`: reuse a unique match to the selected Xcode app's configured Clerk publishable key; create an application named after the Xcode app if the account has none and the app has no existing Clerk configuration; ask which application to use or create when the choice is unclear. The agent resumes with `--app <id>` and the same setup options. App names, unrelated environment keys, and failed list requests must not be treated as a match or an empty account.
- Authenticated setup can open browser login in agent mode. The user completes sign-in, and the same invocation continues; the existing login timeout and cancellation apply.
- Platform API keys are checked by the setup requests that need them; init does not make an extra application-list request to validate a key. Stored OAuth sessions are checked when choosing automatic accountless setup. An explicit authenticated flow can open browser login for the user.
- Agent mode never mints a fresh accountless application over an existing unclaimed one on re-run — see [Accountless breadcrumb](#accountless-breadcrumb)

## Flow

1. Detect the framework or create the requested starter project.
2. Native Apple projects use the dedicated flow described above and return with
   completed setup and any remaining source/build work. Read-only native runs
   return their inspection without authentication or setup changes.
3. Other frameworks choose accountless, authenticated, or manual setup. Explicit
   `--accountless` forces accountless where supported; `--login`, `--app`, and an
   existing linked profile choose authenticated setup. An unauthenticated agent
   uses accountless when supported; an unsupported agent project without an app
   receives manual guidance. Unauthenticated human bootstrap defaults to
   accountless where supported; existing human projects authenticate.
4. Validate accountless-only flags (`--template`, `--fresh`). Authenticate and link
   a real application when required. If login is needed, open the browser and
   wait for the user to finish signing in before continuing setup.
5. Detect existing authentication libraries and install the selected framework SDK.
6. Prepare scaffolding, show the preview and Git-change warning, and confirm edits.
7. Write files, run project formatters, and scan for remaining integration issues.
8. Pull development keys for authenticated frameworks that consume env files, or
   create/reuse accountless keys and their claim breadcrumb.
9. Print completion guidance and offer optional Clerk agent skills installation.

## Framework Detection

Detects the project's framework from `package.json` dependencies (checked top-to-bottom, first match wins):

| Dependency              | Framework      | Clerk SDK                     | Publishable Key Env Var             | Accountless |
| ----------------------- | -------------- | ----------------------------- | ----------------------------------- | ----------- |
| `next`                  | Next.js        | `@clerk/nextjs`               | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes         |
| `astro`                 | Astro          | `@clerk/astro`                | `PUBLIC_CLERK_PUBLISHABLE_KEY`      | Yes         |
| `nuxt`                  | Nuxt           | `@clerk/nuxt`                 | `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes         |
| `@tanstack/react-start` | TanStack Start | `@clerk/tanstack-react-start` | `VITE_CLERK_PUBLISHABLE_KEY`        | Yes         |
| `react-router`          | React Router   | `@clerk/react-router`         | `VITE_CLERK_PUBLISHABLE_KEY`        | Yes         |
| `vue`                   | Vue            | `@clerk/vue`                  | `VITE_CLERK_PUBLISHABLE_KEY`        | No          |
| `expo`                  | Expo           | `@clerk/expo`                 | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | No          |
| `react`                 | React          | `@clerk/react`                | `VITE_CLERK_PUBLISHABLE_KEY`        | No          |
| `vite`                  | JavaScript     | `@clerk/clerk-js`             | `VITE_CLERK_PUBLISHABLE_KEY`        | No          |
| `express`               | Express        | `@clerk/express`              | `CLERK_PUBLISHABLE_KEY`             | No          |
| `fastify`               | Fastify        | `@clerk/fastify`              | `CLERK_PUBLISHABLE_KEY`             | No          |

Native mobile platforms may not have a `package.json`, so they are detected from project marker files when no npm framework matches:

| Marker files                                                        | Framework            | Clerk SDK                                         | Publishable Key Env Var |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------------- | ----------------------- |
| `*.xcodeproj` / `*.xcworkspace`                                     | iOS or macOS (Swift) | `ClerkKit` + `ClerkKitUI` (Swift Package Manager) | `CLERK_PUBLISHABLE_KEY` |
| `app/src/main/AndroidManifest.xml` / `src/main/AndroidManifest.xml` | Android (Kotlin)     | `com.clerk:clerk-android-ui` (Gradle)             | `CLERK_PUBLISHABLE_KEY` |

A bare `Package.swift` or `build.gradle` is not sufficient detection evidence.
Native Apple projects use the Xcode setup flow above; the shared explicit framework
selector is `--framework ios` for both iOS and macOS. Android prints Gradle setup
instructions. Native packages are not installed through a JavaScript package manager.

The **Accountless** column indicates whether the framework's Clerk SDK supports accountless mode (auto-generated temporary dev keys). Accountless is the default for unauthenticated runs on Yes-row frameworks — during bootstrap (new projects) in human mode, and in all agent-mode runs. In human mode, an unauthenticated re-run in an existing project still triggers the authenticated flow. `--accountless` forces accountless anywhere a Yes-row framework is detected (existing projects included, even when logged in); passing it for a No-row framework exits with a usage error. In agent mode, an authenticated run on an accountless-capable framework creates a real app named after the project and links it.

Package manager is detected from lock files: `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

## Scaffolding

Web framework scaffolding uses the adapters below. Native Apple setup returns
through its dedicated engine; Android supplies post-install instructions.

All scaffolding is idempotent — files are skipped if they already contain Clerk setup.

### Next.js (App Router)

| Action | File                                  | Description                                           |
| ------ | ------------------------------------- | ----------------------------------------------------- |
| CREATE | `proxy.ts` or `middleware.ts`         | Bare `clerkMiddleware` (no route protection)          |
| MODIFY | `app/layout.tsx`                      | Add `ClerkProvider` import and wrap `<body>` children |
| CREATE | `app/sign-in/[[...sign-in]]/page.tsx` | Sign-in page with `<SignIn />` component              |
| CREATE | `app/sign-up/[[...sign-up]]/page.tsx` | Sign-up page with `<SignUp />` component              |

The middleware filename is version-aware: `proxy.ts` for Next.js 16+, `middleware.ts` for ≤15. Existing middleware files are preserved and composed with `clerkMiddleware`.

### Next.js (Pages Router)

| Action        | File                               | Description                              |
| ------------- | ---------------------------------- | ---------------------------------------- |
| CREATE        | `proxy.ts` or `middleware.ts`      | Bare `clerkMiddleware` (no protection)   |
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

### Expo

| Action        | File                    | Description                                                          |
| ------------- | ----------------------- | -------------------------------------------------------------------- |
| CREATE/MODIFY | `[src/]app/_layout.tsx` | Wrap the expo-router root layout with `ClerkProvider` + `tokenCache` |

The root layout is created (with a `<Slot />`) when missing and `expo-router` is a dependency; existing layouts have their main JSX return wrapped (guard returns like `if (!loaded) return null` are left alone). Wrapping is scoped to the default export — a function declaration, an arrow function, or either reached through `export default Name` — so sibling exports like the documented `ErrorBoundary` are never wrapped by mistake. Shapes that can't be resolved (a HOC-wrapped export, a concise arrow body) are skipped with a post-instruction rather than guessed at. Post-instructions cover `npx expo install expo-secure-store` (required by `@clerk/expo/token-cache`, installed via `expo install` so the version matches the project's Expo SDK), enabling the Native API in the Dashboard, and adding sign-in/sign-up screens.

**Bootstrap (new project)**: `clerk init --starter --framework expo` scaffolds a new app via `create-expo-app`.

### Express

| Action | File                     | Description                                              |
| ------ | ------------------------ | -------------------------------------------------------- |
| MODIFY | server entry (see below) | Add `clerkMiddleware()` right after `express()` creation |
| CREATE | `types/globals.d.ts`     | `@clerk/express/env` type reference (TypeScript only)    |

A post-instruction reminds the user that `types/globals.d.ts` must be covered by the tsconfig `include` — a config scoped to `["src"]` never loads it and the `req.auth` augmentation silently doesn't apply.

### Fastify

| Action | File                     | Description                                                    |
| ------ | ------------------------ | -------------------------------------------------------------- |
| MODIFY | server entry (see below) | Register `clerkPlugin` right after the `Fastify(...)` creation |

Express and Fastify share the server-entry scaffolding in [`node-server.ts`](./frameworks/node-server.ts). The entry file is resolved from `package.json#main` (ignored when it points at build output like `dist/`) and common candidates (`[src/]index|server|app|main` with `.ts/.mts/.js/.mjs/.cjs`, ordered by basename so an unrelated `src/app.ts` can't outrank a root `index.js`). The resolved path is the one named in the `--env-file` post-instruction. Both ESM (`import`) and CommonJS (`require`, including the inline `require("fastify")(...)` form) are supported; injection lands after the full creation statement, so multi-line options objects and chained calls (e.g. `.withTypeProvider()`) are safe. When no entry or creation call is found, a post-instruction with the quickstart link is printed instead.

### Native Apple (iOS/macOS Swift) / Android (Kotlin)

Native Apple setup can link SDK products, configure supported SwiftUI templates, update eligible entitlements, and register the selected native app. Custom Swift integration remains manual, with independent SDK installation and registration available when their prerequisites hold. Explicit `--prebuilt-auth-ui` and `--sign-in-with-apple` requests retain their own prerequisites. See [Native Apple setup](#native-apple-setup-and-inspection) for SDK selection, entitlements creation, and mutation boundaries.

Android prints the Gradle SDK step for `com.clerk:clerk-android-*`.

## Agent skills install

After scaffolding (and after env keys are pulled or accountless instructions are printed), `clerk init` offers to install Clerk's agent skills via the [`skills`](https://www.npmjs.com/package/skills) CLI. The runner is detected from the project's package manager (`bunx`, `npx`, `pnpm dlx`, or `yarn dlx`), so a Bun project installs via `bunx skills add ...`, a pnpm project via `pnpm dlx skills add ...`, and so on. This step is optional and non-fatal: if no package runner is available on PATH or an install command exits non-zero, init prints a yellow warning with a runner-appropriate manual command and still exits successfully.

- **Human mode**: prompts `Install agent skills? (...)` defaulting to yes. Pass `--no-skills` to suppress the prompt entirely, or `-y/--yes` to accept it without confirmation. When more than one runner is available, a second prompt picks which one to use (the project's package manager wins by default).
- **Agent mode**: skills are installed non-interactively with `-y -g` flags (no prompt shown). Pass `--no-skills` to skip entirely.

A fixed default set is installed from [`clerk/skills`](https://github.com/clerk/skills), covering the `cli/`, `core/`, and `features/` directories:

- **CLI**: `clerk-cli`
- **Core**: `clerk-setup`, `clerk-custom-ui`, `clerk-backend-api`
- **Features**: `clerk-orgs`, `clerk-testing`, `clerk-webhooks`

The detected framework dependency adds one more skill on top:

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

Express and Fastify projects don't get a framework-specific skill — `clerk-backend-api` (now a default) already covers their needs.

These skills version independently of the CLI, so no pin is applied.

### Failure handling

The skills install is optional and non-fatal. If the `skills` CLI can't be fetched by the runner or exits non-zero, init prints a yellow warning with a manual install command and still exits successfully.

Implementation lives in [`skills.ts`](./skills.ts). Note that the E2E fixture setup runs `clerk init --yes --no-skills` because the framework template skills reference auto-generated types (e.g. React Router's `./+types/root`) that don't exist outside a real app directory and would break the fixture's `tsc` step.

## API Endpoints

| Step                   | Method | Base URL                        | Endpoint                       | Description                                                                                                                                   |
| ---------------------- | ------ | ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Create accountless app | `POST` | `CLERK_BAPI_URL` (default BAPI) | `/v1/accountless_applications` | Creates a temporary accountless Clerk application; returns `publishable_key`, `secret_key`, and `claim_url`. Only called in accountless mode. |

See [auth/README.md](../auth/README.md), [link/README.md](../link/README.md), and [env/README.md](../env/README.md) for the API endpoints used by each step.

## Application templates

`--template <name>` is forwarded to `POST /v1/accountless_applications`, which pre-configures the application server-side before the first key is used. This is the one-shot way for an agent to get a shaped instance without an account — a `b2b-saas` accountless app comes back with organizations already enabled, where a default one does not.

| Template   | Shape                            |
| ---------- | -------------------------------- |
| `b2b-saas` | Organizations-first B2B setup    |
| `b2c-saas` | Consumer setup with user billing |
| `native`   | Native/mobile application        |
| `waitlist` | Waitlist sign-up mode            |

The template only applies when a _new_ application is actually created, so `--template` is rejected with a usage error whenever the resolved strategy isn't accountless — whether that's because of an explicit conflicting flag (`--login`, or `--app` once the strategy resolves) or because the run is simply already authenticated (e.g. `CLERK_PLATFORM_API_KEY` is set) or the framework doesn't support accountless at all. The error names the reason, so `--template` is never silently dropped: add `--accountless` to force an accountless app, or drop `--template`. Settings can still be changed afterwards with `clerk config patch`, which also works without an account (see [config accountless mode](../config/README.md#accountless-mode)).

## Accountless breadcrumb

In accountless mode, after calling `POST /v1/accountless_applications`, `clerk init` writes the legacy-named `.clerk/keyless.json` breadcrumb to the project root. The filename remains unchanged so older CLI versions can still claim the application. This file records the claim token extracted from `claim_url` so that `clerk auth login` can automatically claim the temporary application the next time the user authenticates.

```json
{
  "claimToken": "<token>",
  "createdAt": "<ISO timestamp>"
}
```

`.clerk/` is automatically added to `.gitignore` when the breadcrumb is written. The breadcrumb is removed after a successful claim (or when the claim token expires/is already consumed).

### Re-running init on an already-accountless project

The breadcrumb is also what protects an unclaimed accountless app from being orphaned by a later `clerk init` run. As long as `.clerk/keyless.json` is present, the application it points at hasn't been claimed yet. The application and everything configured on it keep existing server-side either way — what the breadcrumb and env keys hold is the only local way to claim or reach it, so overwriting them can strand an application that still has configuration or users on it. So whenever init resolves to accountless mode and finds an existing breadcrumb, it does **not** silently mint a replacement application and overwrite the env keys and breadcrumb with the new one's:

- **Human mode** (no `-y`): prompts `This project already has an unclaimed accountless application (created <date>). Replace it with a new one?`, defaulting to **no**. Declining keeps the existing keys and breadcrumb untouched.
- **Human mode with `-y`, and all agent-mode runs**: never prompt, and default to the same safe answer — **keep the existing application**. `-y` and agent mode both mean "skip confirmations", not "consent to destroying an app that might already have configuration or users on it".
- **`--fresh`**: the explicit escape hatch. Skips the check entirely and mints a new application (and overwrites the env keys and breadcrumb), even in agent mode or with `-y`. Like `--template`, it's a usage error when combined with `--login` or whenever the run doesn't resolve to accountless.

If no breadcrumb exists (first run, or the previous app was already claimed and the breadcrumb removed), init proceeds exactly as before — there's nothing to protect.
