# Init Command

Initializes Clerk in a project by detecting the framework, installing the SDK, and scaffolding framework-specific boilerplate. When the user is unauthenticated and the framework supports accountless, init defaults to accountless mode — auto-generated temporary development keys that a later `clerk auth login` claims automatically — during bootstrap (new projects) in human mode and in all agent-mode runs. Otherwise init logs the user in (interactively) and links a real Clerk application. `--accountless` forces accountless (even when logged in), and so does `--template`; `--login` forces the authenticated flow.

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
```

## Options

| Option                              | Description                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--framework <name>`                | Framework to set up (skips auto-detection). Valid values: `next`, `astro`, `nuxt`, `tanstack-start`, `react-router`, `vue`, `expo`, `react`, `javascript`, `js`, `express`, `fastify`, `ios`, `android`, `macos` (`macos` picks the macOS starter; for an existing app it's the same as `ios`) |
| `--pm <manager>`                    | Package manager to use. Valid values: `bun`, `pnpm`, `yarn`, `npm`. Skips the PM prompt (bootstrap) or overrides lockfile detection (existing project)                                                                                                                                         |
| `--name <project-name>`             | Project name for `--starter` (skips prompt). Must be lowercase, no spaces, no path separators; for an iOS or macOS starter, a Swift name such as `MyApp`                                                                                                                                       |
| `--app <id>`                        | Application ID to link (skips the interactive app picker during authenticated linking)                                                                                                                                                                                                         |
| `--starter`                         | Bootstrap a new project from a starter template (runs the framework generator, installs deps, and scaffolds Clerk)                                                                                                                                                                             |
| `--accountless`                     | Force auto-generated temporary development keys, even when logged in. Only valid on an accountless-capable framework; cannot be combined with `--login` or `--app`                                                                                                                             |
| `--login`                           | Force the authenticated flow: log in (interactively if needed) and link a real application instead of accountless keys. Errors in agent mode when unauthenticated (agents can't run OAuth)                                                                                                     |
| `--template <name>`                 | Pre-configure the accountless application at creation: `b2b-saas`, `b2c-saas`, `native`, `waitlist`. Implies `--accountless`. Errors with `--login`, `--app`, or a framework without accountless support (see [Application templates](#application-templates))                                 |
| `--fresh`                           | Replace an existing unclaimed accountless application with a new one, instead of keeping it (see [Accountless breadcrumb](#accountless-breadcrumb)). Only applies when the run resolves to accountless — errors otherwise; cannot be combined with `--login`                                   |
| `--dry-run`                         | Inspect the existing project and print its setup plan without signing in or changing anything. Supported for iOS, macOS, and Android                                                                                                                                                           |
| `--json`                            | Print the setup result as JSON, including the agent handoff. Supported for iOS, macOS, and Android, including a new app with `--starter` and `--framework ios` or `macos`                                                                                                                      |
| `--xcode-project <path>`            | Xcode project or workspace to set up. Selects iOS setup even when the directory has no root Xcode project                                                                                                                                                                                      |
| `--xcode-target <name-or-id>`       | Xcode app target to set up, by name or ID                                                                                                                                                                                                                                                      |
| `--xcode-configuration <name>`      | Xcode build configuration to inspect instead of Debug and Release                                                                                                                                                                                                                              |
| `--apple-sdk <products>`            | `core` (ClerkKit) or `ui` (ClerkKit + ClerkKitUI)                                                                                                                                                                                                                                              |
| `--bundle-id <id>`                  | Bundle ID for a new iOS or macOS app with `--starter`, or to register when Xcode's is ambiguous                                                                                                                                                                                                |
| `--app-id-prefix <prefix>`          | 10-character Apple App ID Prefix for a new native registration                                                                                                                                                                                                                                 |
| `--team-id <id>`                    | Apple Developer Team ID for a new iOS or macOS app with `--starter` (skips the team prompt)                                                                                                                                                                                                    |
| `--sign-in-with-apple`              | Enable native Sign in with Apple (entitlement and Clerk Apple connection)                                                                                                                                                                                                                      |
| `--prebuilt-auth-ui`                | Add Clerk's prebuilt sign-in screen to an unchanged SwiftUI (ClerkKitUI) or Compose (clerk-android-ui) starter                                                                                                                                                                                 |
| `--android-module <path>`           | Android application module to set up, relative to the project root. Selects Android setup even when the directory has no root manifest; required when the project has several application modules                                                                                              |
| `--android-package <id>`            | The installed `applicationId` to register, including any variant suffix, when Gradle's isn't one plain literal (flavors, a computed value, a suffix outside the debug build type)                                                                                                              |
| `--android-fingerprint <sha256...>` | SHA-256 signing certificate fingerprints to register besides the debug keystore's: a release or Play App Signing certificate, or this machine's when `keytool` is unavailable (from `./gradlew signingReport`)                                                                                 |
| `--android-sdk <artifact>`          | `core` (`com.clerk:clerk-android-api`, the default) or `ui` (`com.clerk:clerk-android-ui` plus `androidx.lifecycle:lifecycle-viewmodel-compose`)                                                                                                                                               |
| `--relink`                          | Let `--app` replace a link to a different application; a usage error without `--app`. Without it, agent mode stops instead of relinking (see [Agent Mode](#agent-mode))                                                                                                                        |
| `-y, --yes`                         | Skip y/n confirmation prompts only. It neither forces nor bypasses accountless — the strategy is picked by auth state, mode, and flags. It does **not** replace an existing unclaimed accountless app — that still requires `--fresh`                                                          |
| `--no-skills`                       | Skip the optional agent skills install prompt at the end of init                                                                                                                                                                                                                               |

`--keyless` remains accepted as a deprecated, hidden compatibility alias for `--accountless`. Use `--accountless` in all new commands and documentation.

## Agent Mode

When running in agent mode (`--mode agent`, `CLERK_MODE=agent`, a recognized agent run, or non-TTY), the command runs the full init flow non-interactively:

- All confirmation prompts are auto-skipped (as if `--yes` was passed)
- For **existing projects**: framework and package manager are auto-detected, no flags required
- For **new projects** (`--starter` or blank directory): `--framework` is required (no way to auto-detect in an empty dir). Package manager is auto-selected by availability (bun → pnpm → yarn → npm) unless `--pm` is provided
- Project name defaults to the framework's default (e.g. `my-clerk-next-app`) unless `--name` is provided
- An Android starter (`--framework android`) takes `--name` and `--android-package` (defaulting to `com.example.<lowercased name>`); with `--json`, `--name` is required and a missing or invalid answer is an `input-required` status, as for the Apple starter. Without `--app` or a linked profile, init creates the app and prints the next step, `cd <app> && clerk init --app <app_id> --json`, with this run's Android options (see **New apps** under Android)
- An Android project needs a chosen application too: without `--app` or a linked profile, init prints `clerk init --app <app_id> --json` with this run's `--android-*` options (with `--json`, as an `application-required` status). With one, `--json` reports `selection-required` (several application modules; pass `--android-module`) or `input-required` (no signing certificate fingerprint is known and nothing is registered yet; pass `--android-fingerprint`) before anything is written, and otherwise the setup result with the Kotlin handoff (see [Android (Kotlin)](#android-kotlin))
- An iOS or macOS starter (`--framework ios` or `macos`) takes `--bundle-id` (defaulting to Xcode's Organization Identifier plus the name) and `--team-id` (defaulting to the only paid team, or else the only team, in Xcode's accounts). Without `--app` or a linked profile, init creates the app and prints the next step, `cd <app> && clerk init --app <app_id> --json`, with this run's setup options (see **New apps** under iOS and macOS)
- For accountless-capable frameworks with no `--app` and no linked profile:
  - When **authenticated**, init creates a real Clerk app named after the project (`package.json#name`, `--name`, or directory basename) and links it.
  - When **unauthenticated**, init uses accountless: the app runs on auto-generated dev keys, and init writes a legacy-named `.clerk/keyless.json` breadcrumb so the next `clerk auth login` claims the app automatically.
- For frameworks that require API keys, init will not pick or create an app in agent mode; pass `--app <id>` or link the project first to pull real keys
- An iOS or macOS `--starter` without `--app` stops once its own answers are valid, before anything is written, when the directory is already covered by a link (its own, a parent's, or the repository's), since the new app would otherwise set itself up against an application that may belong to another project. It's a usage error, and with `--json` an `input-required` status with `link: { flag: "--app", question, issue, current, scope }`: pass `--app` with the linked application to share it, or `--app` with another.
- `--app` naming a different application than an existing link stops with a usage error instead of relinking, unless `--relink` is passed. Inside a Git repository the link belongs to the whole repository, so relinking one folder would switch every project there; a new `--starter` app is checked against the directory it's created in, before anything is written (an iOS or macOS starter checks once its name, folder, Bundle ID, and team are valid, so the link is never settled for an app it then rejects; the stop offers `--app <linked app>` to share the repository's application, `--relink`, or creating the app outside the repository), and a project init generates in a blank directory is checked once it exists, before it's linked. With `--json`, the error is also printed as `{ "status": "input-required", "link": { "flag": "--relink", "question", "issue", "current", "requested", "scope" } }`. Outside a repository, linking a folder whose parent is linked elsewhere gives it a link of its own and isn't stopped. Human mode keeps `clerk link`'s own confirmation
- `--login` while unauthenticated exits with a usage error (agents can't complete the interactive browser login)
- Agent mode never trusts the mere _presence_ of a stored credential the way human mode does — a stored session that turns out to be expired/broken (e.g. keyring holds a stale OAuth session) is validated before init decides it's "authenticated". A broken credential is treated as unauthenticated, which routes an accountless-capable framework to accountless instead of blocking on a browser OAuth round-trip an agent can never complete. If `--login` (or a real app target) forces the authenticated flow anyway and the credential turns out broken, init exits with a usage error instead of attempting an interactive login
- Agent mode never mints a fresh accountless application over an existing unclaimed one on re-run — see [Accountless breadcrumb](#accountless-breadcrumb)

## Flow

1. Gathers project context (framework, router variant, TypeScript, `src/` directory, package manager)
2. Determines the strategy (in precedence order). In agent mode, "authenticated" here means a _validated_ credential (a real `CLERK_PLATFORM_API_KEY`, or a stored session that still exchanges for a valid token) — not just the presence of something in the keyring, since agent mode has no interactive fallback if a stale credential turns out to be unusable:
   - **`--accountless`**: forces accountless mode, even when logged in. Only valid on an accountless-capable framework, and cannot be combined with `--login` or `--app` (usage errors otherwise). The app runs on auto-generated dev keys; init writes a legacy-named `.clerk/keyless.json` breadcrumb so the next `clerk auth login` claims the app automatically
   - **`--template`**: implies `--accountless` and creates an accountless application from the template, even when logged in or linked. With `--login`, `--app`, or a framework without accountless support it exits with a usage error instead
   - **`--login`**: forces the authenticated flow. In agent mode while unauthenticated (or while stored credentials are broken) this exits with a usage error, since agents can't complete the interactive browser login
   - **Real app target** (`--app` or linked profile): authenticates, links if needed, and pulls real API keys into `.env`; a native iOS, macOS, or Android project runs native setup instead of steps 4 to 15
   - **Agent + non-accountless framework + no real app target**: scaffolds locally and prints manual setup instructions instead of selecting or creating an app
   - **Agent + accountless-capable framework + authenticated + no real app target**: creates a real Clerk app named after the project, links it, and pulls real API keys into `.env`
   - **Agent + accountless-capable framework + unauthenticated + no real app target**: uses accountless mode — the app runs on auto-generated dev keys and the breadcrumb lets the next `clerk auth login` claim it. A broken/stale stored credential (present in the keyring but no longer valid) is treated the same as unauthenticated, so this is also the fallback when the presence-only check would have wrongly said "authenticated"
   - **Human mode + bootstrap + accountless-capable framework + not authenticated**: uses accountless mode
   - **Human mode + existing project + not authenticated**: runs the authenticated flow, which triggers an interactive login so real keys can be pulled. `-y` does not bypass this — it only suppresses y/n confirmation prompts, not authentication
   - `--fresh` is rejected with a usage error whenever the resolved strategy above isn't accountless — see [Accountless breadcrumb](#accountless-breadcrumb)
3. **Authenticated mode only**: authenticates via `clerk auth login` (skipped if already authenticated) and links the project via `clerk link` (skipped if already linked)
4. Displays detected framework and variant
5. Detects existing auth libraries (NextAuth, Auth0, Supabase, Firebase, Passport, Better Auth, Kinde) and shows migration guidance
6. Installs the appropriate Clerk SDK (skips if already present)
7. Generates a scaffold plan for the detected framework
8. Warns if the git working tree has uncommitted changes
9. Previews planned file changes and asks for confirmation
10. Writes scaffold files to disk
11. Runs project formatters (Prettier/Biome) on generated files
12. Scans for issues: hardcoded keys, leftover auth-library imports, stale API calls
13. Prints a summary of created, modified, and skipped files with recommendations
14. **Authenticated mode**: pulls development instance API keys via `clerk env pull`
15. **Accountless mode** (unauthenticated runs whose resolved strategy in step 2 is accountless — an unauthenticated human-mode rerun on an existing project resolves to the authenticated flow instead): mints an accountless application and prints instructions for development without API keys and how to connect a Clerk account later — unless an unclaimed accountless app already exists for this project (see [Re-running init on an already-accountless project](#re-running-init-on-an-already-accountless-project)), in which case the existing keys are kept and reported instead
16. Optionally installs Clerk agent skills (cli + core + features, plus a framework-specific skill) via the project's package runner (see [Agent skills install](#agent-skills-install))

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

| Marker files                                                        | Framework        | Clerk SDK                             | Publishable Key Env Var |
| ------------------------------------------------------------------- | ---------------- | ------------------------------------- | ----------------------- |
| `*.xcodeproj` / `*.xcworkspace`                                     | iOS (Swift)      | `ClerkKit` (Swift Package Manager)    | `CLERK_PUBLISHABLE_KEY` |
| `app/src/main/AndroidManifest.xml` / `src/main/AndroidManifest.xml` | Android (Kotlin) | `com.clerk:clerk-android-ui` (Gradle) | `CLERK_PUBLISHABLE_KEY` |

A bare `Package.swift` or `build.gradle` is intentionally **not** enough — those also match server-side Swift packages and non-Android JVM projects. For native platforms the Clerk SDK cannot be installed by a JS package manager, and the publishable key is configured in source code (`Clerk.configure(...)` / `Clerk.initialize(...)`), so once an application is linked init sets the project up natively instead of pulling keys into an env file: see [iOS and macOS (Swift)](#ios-and-macos-swift) and [Android (Kotlin)](#android-kotlin). Only an iOS project on a machine without Xcode keeps the older path: init links the app, prints the Swift Package Manager steps, and pulls the key into `.env`.

The **Accountless** column indicates whether the framework's Clerk SDK supports accountless mode (auto-generated temporary dev keys). Accountless is the default for unauthenticated runs on Yes-row frameworks — during bootstrap (new projects) in human mode, and in all agent-mode runs. In human mode, an unauthenticated re-run in an existing project still triggers the authenticated flow. `--accountless` forces accountless anywhere a Yes-row framework is detected (existing projects included, even when logged in); passing it for a No-row framework exits with a usage error. In agent mode, an authenticated run on an accountless-capable framework creates a real app named after the project and links it.

Package manager is detected from lock files: `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

## Scaffolding

Scaffolding is supported for every detected web framework. Native projects are set up by their own engines instead of a scaffold plan: iOS and macOS on a Mac with Xcode (where `--starter` can also create one), and Android everywhere; see [iOS and macOS (Swift)](#ios-and-macos-swift) and [Android (Kotlin)](#android-kotlin). Without Xcode, the iOS scaffolder writes no files and prints the quickstart steps as post-instructions.

All scaffolding is idempotent — files are skipped if they already contain Clerk setup.

### Next.js (App Router)

| Action | File                                  | Description                                           |
| ------ | ------------------------------------- | ----------------------------------------------------- |
| CREATE | `proxy.ts` or `middleware.ts`         | Bare `clerkMiddleware` (no route protection)          |
| MODIFY | `app/layout.tsx`                      | Add `ClerkProvider` import and wrap `<body>` children |
| CREATE | `app/sign-in/[[...sign-in]]/page.tsx` | Sign-in page with `<SignIn />` inside `<Suspense>`    |
| CREATE | `app/sign-up/[[...sign-up]]/page.tsx` | Sign-up page with `<SignUp />` inside `<Suspense>`    |

The middleware filename is version-aware: `proxy.ts` for Next.js 16+, `middleware.ts` for ≤15. Existing middleware files are preserved and composed with `clerkMiddleware`.

`clerk init` skips an auth page when the project already has an optional catch-all page for the same URL, including one inside route groups, such as `app/(marketing)/sign-in/[[...sign-in]]/page.tsx`. The skip reason names the existing file.

The auth pages wrap the component in `<Suspense>` because `<SignIn />` and `<SignUp />` read the URL during prerendering. For new projects (`--starter` or blank directory), `app/layout.tsx` also gets an auth header with both `<Show>` blocks inside one `<Suspense>`, because `<Show>` reads the user's session from the request. With Cache Components enabled, the default for new `create-next-app` projects, `next build` fails without these boundaries.

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

| Action        | File                       | Description                                     |
| ------------- | -------------------------- | ----------------------------------------------- |
| CREATE/MODIFY | `src/start.ts`             | Register CSRF middleware, then Clerk middleware |
| MODIFY        | `src/routes/__root.tsx`    | Add `ClerkProvider` and wrap body contents      |
| CREATE        | `src/routes/sign-in.$.tsx` | Sign-in route with `<SignIn />` component       |
| CREATE        | `src/routes/sign-up.$.tsx` | Sign-up route with `<SignUp />` component       |

CSRF middleware needs `@tanstack/react-start` 1.168.10 or later, with `@tanstack/react-router` 1.170.7 or later. When the version is older or can't be confirmed, or an existing `start.ts` can't be edited safely, `clerk init` leaves the file unchanged and prints the manual steps.

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

### Android (Kotlin)

- **New apps.** `clerk init --starter` offers Android (Jetpack Compose) everywhere, alongside the web frameworks and, on a Mac with Xcode, the Apple starters; `--framework android` selects it. It asks for the app name (an identifier such as `MyApp`) and the applicationId (default `com.example.<lowercased name>`), then writes a project shaped like Android Studio's Empty Activity template before signing in or choosing a Clerk application: `settings.gradle.kts`, the root build script, `gradle.properties`, a version catalog pinning AGP 9.2.1, Kotlin 2.3.21 (through the Compose compiler plugin alias, so AGP's built-in Kotlin isn't the 2.2.10 the SDK can't be consumed by), and a Compose BOM; `app/` with `minSdk` 24, the manifest, `MainActivity`, the theme, and a vector launcher icon; `.gitignore` and an initial Git commit (unless the folder is already inside a repository); and the Gradle wrapper. The wrapper's `gradlew`, `gradlew.bat`, and `gradle-wrapper.jar` (Gradle 9.4.1) are embedded in the CLI and copied in, with the distribution's checksum pinned in `gradle-wrapper.properties`, so the new project builds with `./gradlew :app:assembleDebug` without Gradle on PATH; the Android SDK and a JDK 17+ are still needed to build. Setup then runs as for an existing project, with no confirmation prompt and the UI artifact by default. The new app has no screens of its own, so its sign-in screen defaults to on, with `--yes` as at the prompt, unless `--android-sdk core` is chosen; an agent still adds it only with `--prebuilt-auth-ui`. `--android-module` and the accountless flags are rejected before anything is written. When an agent hasn't chosen a Clerk application yet, it's told to run `cd <app> && clerk init --app <app_id> --json`, carrying this run's Android options.
- **New apps with `--json`.** `clerk init --starter --framework android --json` reports like the Apple starters: `--name` is required, an answer only the user can give stops before anything is written with `input-required` (`field` is `name` or `androidPackage`, with the flag and question), every status after the app is written carries `starter: { projectName, platform: "android", projectDir, continuation }`, and a setup error with no status of its own is `setup-interrupted`, so an agent continues inside the new app instead of rerunning `--starter`.
- **Prebuilt sign-in screen.** With the UI artifact, an unchanged starter's `MainActivity` is replaced by one that shows a progress indicator until `Clerk.isInitialized`, `AuthView(isDismissible = false)` until `Clerk.isAuthFlowCompleteFlow`, then `UserButton()` and the signed-in email, keeping the app's theme. Anything other than the unchanged template is left alone, and the handoff's `optional-sign-in-ui` task stays behind user intent.
  Once init has linked a Clerk application (the usual authenticated flow), it sets up the Gradle application module directly instead of scaffolding files or pulling keys into `.env`. It works on any OS: inspection reads Gradle scripts, the version catalog, and the manifest as text, never running Gradle, and the only tool it runs is `keytool`, to read the debug certificate. The engine lives in [`android/`](./android/) and mirrors the iOS one module for module (discovery, project inspection, plan, SDK, identity, remote, workflow, coordinator, handoff, doctor); what the two share (resolving the instance, idempotent registration, file snapshots, backups, and rollback, progress) lives in [`native/`](./native/).

- **Discovery.** Finds application modules (a `src/main/AndroidManifest.xml` beside a build script that applies `com.android.application`, literally or through a catalog alias) up to three folders deep, and asks when there's more than one. `--android-module` selects explicitly, and selects Android setup even when the directory has no root manifest. Both Kotlin and Groovy DSL scripts are read, and `settings.gradle(.kts)` for `pluginManagement` versions and the module's Gradle project path (`include` and `projectDir` remaps), which the handoff's build task uses. Anything the inspection can't read as one plain value is refused rather than guessed: a computed or repeated `namespace` or `applicationId`, product flavors, an `applicationIdSuffix` outside the debug build type, a manifest with several `<application>` elements, more than one top-level `dependencies` block, a `clerk.xml` or `clerk_publishable_key` resource it didn't write. A refused layout doesn't end init: it says why, then takes the path Android had before native setup, linking the app, pulling the publishable key into the env file, and printing the manual quickstart steps (with `--json`, a `manual-setup-required` status carrying `reason`, `envFile`, and `next`). A value that merely can't be read, such as `minSdk` set by a convention plugin, is noted and setup goes on without it.
- **Identity.** The registered package name is the installed `applicationId`: `defaultConfig.applicationId` plus the debug build type's `applicationIdSuffix` when there is one, since the development instance is what debug builds use; `--android-package` names it when Gradle's value isn't one plain literal. The signing fingerprints are the SHA-256 of this machine's debug certificate (`~/.android/debug.keystore`, or under `ANDROID_USER_HOME`; read with `keytool` from PATH, `JAVA_HOME`, or Android Studio's bundled JDK) plus any `--android-fingerprint`, normalized to uppercase colon-separated form and deduplicated. Clerk serves `/.well-known/assetlinks.json` from the registered fingerprints, which passkeys need, so a new registration needs at least one: when the keystore doesn't exist yet or no `keytool` is available, init says so and what to pass, and an agent gets an `input-required` status naming `--android-fingerprint`. The JSON result's `identity` shows what was registered and where each fingerprint came from.
- **Changes**, previewed before they're applied:
  - adds `com.clerk:clerk-android-api` (or `clerk-android-ui` with `--android-sdk ui`, plus `androidx.lifecycle:lifecycle-viewmodel-compose`) at the tested baseline, `1.3.0`, through the version catalog when the project has one (new `clerk` version and `clerk-android-*` library entries, or an existing entry for the same module) and as a literal otherwise. An SDK the project already declares is kept and its version checked against the baseline, never replaced;
  - raises `minSdk` to 24 when it's lower: a literal in the module script, or the shared catalog value a `libs.versions.x` reference reads, in which case the preview says every module reading it moves too. An SDK already declared below the baseline is reported, not replaced: the dependency lines and their catalog entries are left out while the `minSdk` raise still applies;
  - creates `ClerkApplication` in the module's namespace with `Clerk.initialize(this, publishableKey = getString(R.string.clerk_publishable_key))`, or adds that call after `super.onCreate()` in the `Application` subclass the manifest already registers. A class that already calls `Clerk.initialize` is left alone (the handoff notes the key to use); a class that can't be edited safely (a Java class, a missing source file, no single `onCreate` with a standalone `super.onCreate()`) is left to the handoff's `initialize-clerk` task;
  - registers the generated class with `android:name` and adds the `INTERNET` permission;
  - writes the development publishable key to `src/main/res/values/clerk.xml` (a string resource, marked as generated so reruns can rewrite it; never a secret key, and nothing in `.env`);
  - registers `{ namespace: "android_app", package_name, fingerprints }` on the development instance with a deterministic idempotency key, reconciling a registration a lost response or a concurrent run left behind, then enables Native API, then reads both back to verify.
- **Kotlin.** The SDK is compiled with Kotlin 2.4, and a Kotlin compiler reads class metadata up to one minor version ahead, so 2.3 or newer is required (verified against 1.3.0: 2.3.21 compiles, 2.2.21 fails with an incompatible metadata version). The version is read from the catalog entry a Kotlin plugin alias uses, a literal plugin version, or a `kotlin-gradle-plugin` classpath entry. A module relying on AGP 9's built-in Kotlin with no Kotlin Gradle plugin declared compiles with the 2.2.10 AGP 9.0 through 9.4 bundle, so init stops with the fix (put a Kotlin Gradle plugin of 2.3+ on the classpath, which built-in Kotlin then uses); the toolchain is never rewritten. When the build has `buildSrc`, `build-logic`, an included build, or a plugin id init doesn't recognize, a convention plugin may be supplying Kotlin, so an undeclared version is a warning to check rather than a stop, and below AGP 9 whether Kotlin applies at all is reported as unknown. The OAuth redirect intent filter comes from the SDK's own manifest, so no deep-link configuration is needed.
- **Registrations that exist.** A registration for the package is reused when it carries every known fingerprint (extra certificates are fine). One that lacks this machine's fingerprint (a second developer's machine, say) still gets the full local setup and Native API; the registration is then reported as manual, naming the fingerprint and the Dashboard's Native Applications page in the preview, the result (`remote: "manual"` with the message), and the handoff's `native-registration` item, since the Platform API can't update a registration yet. An existing registration with no fingerprint known locally is reused with a warning, since it can't be checked.
- **Agents** follow the usual rules: without `--app` or a linked project they get manual guidance. `--json` prints the result and a `clerk-android-integration` handoff with the development publishable key (never a secret key), the module and `applicationId`, and the Kotlin tasks: `initialize-clerk` (done when the CLI did it), `optional-sign-in-ui` behind user intent with `--android-sdk ui`, `build-module` with the exact `./gradlew :<module>:assembleDebug`, and `runtime-verification`, left untested unless the user asks.
- **Safety.** The same rules as iOS: every write checks the file hasn't changed since the preview (content, mode, device, and inode). Files git can't restore are backed up to `.clerk/backups/` at the project root, outside `src/`, where Gradle would compile or bundle them, and a failed write restores earlier ones and attempts no remote change. Registration is idempotent, so rerunning init finishes anything left incomplete and a second run changes nothing.
- **Exit codes.** 0 when setup succeeds, even if Kotlin integration or manual steps remain (the JSON `status` says which); nonzero when a step fails, with `android_setup_blocked`, `android_setup_stale`, or `android_remote_verify_failed` as the error code.

`--dry-run` inspects the module without signing in, reading Clerk, or running `keytool`, so the key resource and registration are planned only once an application is chosen. `--prebuilt-auth-ui` applies to an unchanged Android starter as it does to a SwiftUI one; with `--android-sdk core` it's a usage error, since the screen needs `clerk-android-ui`.

```sh
clerk init --dry-run --json
clerk init --android-sdk ui
clerk init --android-module mobile --android-package com.example.app.debug --android-fingerprint AA:BB:... --yes
clerk init --starter --framework android --name MyApp --android-package com.example.myapp --json --app app_123
```

### iOS and macOS (Swift)

Once init has linked a Clerk application (the usual authenticated flow), it sets up the Xcode project directly instead of scaffolding files or pulling keys into `.env`. Xcode is required; JSON (`project.xcproj`) projects need Xcode 27, which init finds in `/Applications` without changing `xcode-select`. Without Xcode (another OS, or a Mac with only the Command Line Tools), init links the app, prints the manual steps, and pulls the key into `.env` as before.

- **New apps.** `clerk init --starter` offers iOS (SwiftUI) and macOS (SwiftUI) on a Mac with Xcode, alongside the web frameworks. It asks for the app name, Bundle ID (the default takes Xcode's Organization Identifier and the name, with underscores as hyphens), and Apple Developer team (read from Xcode's accounts, with a Personal Team's limits marked), then writes a project matching Xcode's SwiftUI App template, before signing in or choosing a Clerk application. Setup then runs as for an unchanged starter, with the team as the App ID Prefix and no confirmation prompt. The new app has no screens of its own, so its sign-in screen defaults to on, with `--yes` as at the prompt, unless `--apple-sdk core` is chosen; an agent still adds it only with `--prebuilt-auth-ui`. A Personal Team can't use Sign in with Apple, so it isn't offered and `--sign-in-with-apple` is a usage error. A Mac app has no simulator to fall back to, so a macOS starter on a Personal Team also leaves out Associated Domains (passkeys and password AutoFill), which that team can't provision. These rules follow the signing team, on every run and for any app: when Xcode's account list marks the team as a Personal Team, setup leaves out Sign in with Apple (and on macOS Associated Domains) and says why, and `clerk doctor` checks the same way instead of reporting them as missing. `--xcode-*` and the accountless flags (`--accountless`, `--template`, `--fresh`) are rejected before anything is written. When an agent hasn't chosen a Clerk application yet, it's told to run `cd <app> && clerk init --app <app_id> --json`, carrying this run's setup options (`--apple-sdk`, `--app-id-prefix` or the starter's team, `--sign-in-with-apple`, `--prebuilt-auth-ui`). For an existing project, that command also keeps its `--xcode-*` and `--bundle-id` selection.
- **New apps with `--json`.** `clerk init --starter --framework ios --json` (or `macos`) reports in JSON like setup on an existing project; a web starter's generator writes to the terminal, so it can't. `--name` is then required instead of defaulting to `MyClerkApp`. Like `clerk migrate --json`, a `--json` starter runs in agent mode unless `--mode` or `CLERK_MODE` says otherwise, so nothing prompts (signing in, choosing or relinking an application, the starter's own questions): it reports `input-required` or `application-required` instead. An answer only the user can give stops before anything is written with `{ "status": "input-required", "input": { "field", "flag", "question", "issue" } }`, plus a `suggestion` (a free default name) or `choices` (the Apple teams that can sign the app) when there are any: a missing or invalid name, a name whose folder exists, a Bundle ID Xcode can't suggest, or a team to choose. `starter` is kept for the new app: once it's written, every JSON status carries `starter: { projectName, platform, projectDir, continuation }`, where `continuation` is the `cd <app> && clerk init --app <app_id> --json ...` that finishes it, with the real application ID when `--app` was passed. If setup then stops with an error that has no status of its own (a failed link, an Xcode failure), init prints `{ "status": "setup-interrupted", "error", "starter", "next" }` so an agent continues inside the new app instead of running `--starter` again, which would refuse the existing folder.
- **Discovery.** Finds app targets in root `.xcodeproj` and `.xcworkspace` bundles and asks when there's more than one. `--xcode-project` and `--xcode-target` select explicitly; projects in subdirectories such as `ios/` need `--xcode-project`. Debug and Release are inspected unless `--xcode-configuration` is given. Both are set up against the development instance only; `clerk doctor` checks Release against production (registration, Associated Domain, and publishable key).
- **Changes**, previewed before they're applied:
  - links ClerkKit (and ClerkKitUI unless `--apple-sdk core`) and resolves packages;
  - adds Associated Domains for the development instance and, for sandboxed macOS apps, outgoing network access;
  - registers the Bundle ID and App ID Prefix and enables Native API;
  - with `--sign-in-with-apple` (or a yes to the prompt), adds the entitlement and enables the native Apple connection without touching its web credentials.
- **Identity.** The Bundle ID comes from Xcode. The App ID Prefix comes from a matching Clerk registration, or else from the project's signing team (Apple uses the Team ID as the prefix for current App IDs): people at a terminal can accept it or enter another, and `--yes` and agents use it unless they pass `--app-id-prefix` (macOS apps always use the signing team). The JSON result's `identity` shows what was registered. With no single signing team, init asks, or an agent passes `--bundle-id` / `--app-id-prefix`.
- **Swift code.** An unchanged SwiftUI starter gets `Clerk.configure` and `.environment(Clerk.shared)`, plus the sign-in screen with `--prebuilt-auth-ui`. Customized apps are left alone; the result links the quickstart for the remaining integration.
- **Agents** follow the usual rules: without `--app` or a linked project they get manual guidance. `--json` prints the result and a handoff with the development publishable key (never a secret key), the remaining tasks, and the Xcode `DEVELOPER_DIR` to build with.
- **Safety.** Every write checks the file hasn't changed since the preview. Files git can't restore are backed up to `.clerk/backups/` at the project root, outside the app's folders so Xcode never bundles them, and a failed write restores earlier ones. Registration is idempotent, so rerunning init finishes anything left incomplete.
- **Exit codes.** 0 when setup succeeds, even if Swift integration or manual steps remain (the JSON `status` says which); nonzero when a step fails.

`--dry-run` inspects the project without signing in or reading Clerk, so capabilities and Sign in with Apple are planned only once an application is chosen. `XcodeGen` and `Tuist` projects get instructions instead of project edits.

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

Native setup (iOS, macOS, and Android) reads and writes the development instance through the Platform API (`CLERK_PLATFORM_API_URL`), with `fetchApplication` always asking for no secret keys:

| Method  | Endpoint                                                                               | Description                                                                                      |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`   | `/v1/platform/applications/{appId}`                                                    | The linked application's development instance and its publishable key                            |
| `GET`   | `/v1/platform/applications/{appId}/instances/{instanceId}/native_settings`             | Whether Native API is enabled                                                                    |
| `PATCH` | `/v1/platform/applications/{appId}/instances/{instanceId}/native_settings`             | Enables Native API                                                                               |
| `GET`   | `/v1/platform/applications/{appId}/instances/{instanceId}/native_applications/ios`     | Registered Bundle IDs and App ID Prefixes                                                        |
| `POST`  | `/v1/platform/applications/{appId}/instances/{instanceId}/native_applications/ios`     | Registers a Bundle ID (with an `Idempotency-Key`)                                                |
| `GET`   | `/v1/platform/applications/{appId}/instances/{instanceId}/native_applications/android` | Registered package names and signing fingerprints                                                |
| `POST`  | `/v1/platform/applications/{appId}/instances/{instanceId}/native_applications/android` | Registers `{ namespace: "android_app", package_name, fingerprints }` (with an `Idempotency-Key`) |

## Application templates

`--template <name>` is forwarded to `POST /v1/accountless_applications`, which pre-configures the application server-side before the first key is used. This is the one-shot way for an agent to get a shaped instance without an account — a `b2b-saas` accountless app comes back with organizations already enabled, where a default one does not.

| Template   | Shape                            |
| ---------- | -------------------------------- |
| `b2b-saas` | Organizations-first B2B setup    |
| `b2c-saas` | Consumer setup with user billing |
| `native`   | Native/mobile application        |
| `waitlist` | Waitlist sign-up mode            |

The template only applies when a _new_ application is created, so `--template` implies `--accountless`: init creates an accountless application even when you're signed in, the project is linked or already set up, or `CLERK_PLATFORM_API_KEY` is set. It's rejected with a usage error when combined with `--login` or `--app`, or when the framework doesn't support accountless. The error names the reason. If the project already has an unclaimed accountless application, init keeps it by default and doesn't apply the template (in human mode without `-y`, it asks first); add `--fresh` to replace it with a new one from the template (see [Accountless breadcrumb](#accountless-breadcrumb)). Settings can still be changed afterwards with `clerk config patch`, which also works without an account (see [config accountless mode](../config/README.md#accountless-mode)).

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
