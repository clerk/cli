# Init Command

Initializes Clerk in a project by detecting the framework, installing the SDK, and scaffolding framework-specific boilerplate. When the user is unauthenticated and the framework supports keyless, init defaults to keyless mode — auto-generated temporary development keys that a later `clerk auth login` claims automatically — during bootstrap (new projects) in human mode and in all agent-mode runs. Otherwise init logs the user in (interactively) and links a real Clerk application. `--keyless` forces keyless (even when logged in); `--login` forces the authenticated flow.

## Usage

```sh
clerk init
clerk init --app app_123
clerk init --framework next
clerk init --starter
clerk init --starter --framework next --pm bun
clerk init --starter --framework next --pm bun --name my-app
clerk init --starter --framework next --keyless
clerk init --login
clerk init --template b2b-saas
clerk init --keyless --fresh
clerk init -y
clerk init --yes
clerk init --no-skills
clerk init --target MyApp
clerk init --target MyApp --yes
clerk init --target MyApp --prebuilt-auth-ui
clerk init --target MyApp --sign-in-with-apple
clerk init --dry-run
clerk init --dry-run --target MyApp
clerk init --dry-run --target MyApp --json
```

## Options

| Option                  | Description                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--framework <name>`    | Framework to set up (skips auto-detection). Valid values: `next`, `astro`, `nuxt`, `tanstack-start`, `react-router`, `vue`, `expo`, `react`, `javascript`, `js`, `express`, `fastify`, `ios`, `android`                                                    |
| `--pm <manager>`        | Package manager to use. Valid values: `bun`, `pnpm`, `yarn`, `npm`. Skips the PM prompt (bootstrap) or overrides lockfile detection (existing project)                                                                                                     |
| `--name <project-name>` | Project name for `--starter` (skips prompt). Must be lowercase, no spaces, no path separators                                                                                                                                                              |
| `--app <id>`            | Application ID to link (skips the interactive app picker during authenticated linking)                                                                                                                                                                     |
| `--starter`             | Bootstrap a new project from a starter template (runs the framework generator, installs deps, and scaffolds Clerk)                                                                                                                                         |
| `--keyless`             | Force auto-generated temporary development keys, even when logged in. Only valid on a keyless-capable framework; cannot be combined with `--login` or `--app`                                                                                              |
| `--login`               | Force the authenticated flow: log in (interactively if needed) and link a real application instead of keyless keys. Errors in agent mode when unauthenticated (agents can't run OAuth)                                                                     |
| `--template <name>`     | Pre-configure the keyless application at creation: `b2b-saas`, `b2c-saas`, `native`, `waitlist`. Only applies when the run resolves to keyless — errors otherwise (see [Application templates](#application-templates)); cannot be combined with `--login` |
| `--fresh`               | Replace an existing unclaimed keyless application with a new one, instead of keeping it (see [Keyless breadcrumb](#keyless-breadcrumb)). Only applies when the run resolves to keyless — errors otherwise; cannot be combined with `--login`               |
| `--dry-run`             | Inspect an existing Xcode project and print a semantic iOS/macOS Clerk setup plan without changing local or remote state                                                                                                                                   |
| `--json`                | Emit the `--dry-run` inspection and setup plan as structured JSON. Implied in agent mode; requires `--dry-run`                                                                                                                                             |
| `--target <name-or-id>` | Select a native Apple application target by target name or PBX object ID for either inspection or setup                                                                                                                                                    |
| `--allow-dirty`         | Allow native Apple setup to update a planned local file that already has changes. Existing bytes still participate in stale-plan and atomic-write validation                                                                                               |
| `--app-id-prefix <id>`  | Apple App ID Prefix to use if the selected native Apple Bundle ID needs a new Clerk registration. Never inferred from `DEVELOPMENT_TEAM`; required in agent mode when local/remote evidence cannot supply it                                               |
| `--sign-in-with-apple`  | Opt into native Sign in with Apple for the selected native Apple target. Adds the exact Apple entitlement and enables the matching native Clerk connection; never requests hosted/web Apple credentials                                                    |
| `--prebuilt-auth-ui`    | Opt into ClerkKitUI's prebuilt authentication UI for an untouched, safely inspectable SwiftUI starter. Existing or customized application UI is preserved and returned for review instead of being rewritten                                               |
| `-y, --yes`             | Skip y/n confirmation prompts only. It neither forces nor bypasses keyless — the strategy is picked by auth state, mode, and flags. It does **not** replace an existing unclaimed keyless app — that still requires `--fresh`                              |
| `--no-skills`           | Skip the optional agent skills install prompt at the end of init                                                                                                                                                                                           |

## Read-only native Apple inspection

`clerk init --dry-run` takes a separate, read-only path for existing native iOS and macOS projects. It inspects Xcode projects and workspaces, application targets and build configurations, Swift Package Manager linkage, target source membership, Swift Clerk setup, and entitlements. It then prints an ordered setup plan with a top-level status of `ready`, `action-required`, or `blocked`.

Automatic mutation currently supports targets whose shipping platforms are all iOS or macOS and that do not explicitly enable Mac Catalyst. A target that also ships visionOS—including Xcode's standard Multiplatform App template—or sets `SUPPORTS_MACCATALYST=YES` is still inspected and receives a blocked plan explaining the boundary, but normal `clerk init` applies no new Clerk setup changes and performs no remote writes. Use a non-Catalyst iOS/macOS target for automatic setup or configure the target manually.

Publishable-key inspection intentionally has a narrow boundary. One literal passed directly to `Clerk.configure(publishableKey:)` in the selected app's startup initializer can be validated with its value redacted. Every other expression is classified as custom: the CLI preserves it without reading its backing file, scheme, environment, or value.

The command does not authenticate, call Clerk APIs, run Xcode, resolve packages, send command telemetry, check for CLI updates, or write project/global CLI files. Publishable key values are never included in output. Flags that imply project creation or already-known remote application state (`--starter`, `--app`, `--app-id-prefix`, `--keyless`, `--login`, `--template`, and `--fresh`) are rejected before inspection. `--sign-in-with-apple` is allowed because dry-run previews only the local entitlement; it reports the Clerk connection as not inspected until a regular authenticated run.

When multiple native Apple application targets are present, the plan is `blocked` until one is selected with `--target <name-or-id>`. A blocked plan still exits successfully because the inspection completed; automation should branch on the JSON `status` field.

## Native Apple local setup

For a native iOS or macOS project, normal `clerk init` re-runs the semantic inspection, builds the complete local plan, previews it with the publishable key redacted, and asks for consent before authentication or local writes. It reuses an existing verified local or remote clerk-ios package when possible; otherwise it adds the official `https://github.com/clerk/clerk-ios` Swift package. For an untouched Clerk integration, it links both `ClerkKit` and `ClerkKitUI` to the exact selected application target so the optional prebuilt `AuthView` path is available. Existing source-proven custom-flow projects remain `ClerkKit`-only unless their source or Xcode graph already requires `ClerkKitUI`.

For a safely inspectable fresh SwiftUI target, the same command selects or creates a Clerk application, fetches only its development publishable key, adds `import ClerkKit`, configures Clerk directly in the single shipping `@main` initializer, and adds `.environment(Clerk.shared)` to the proven `WindowGroup` root. The key is public client configuration and is written directly to Swift source, matching Clerk's Swift setup. It remains in memory until commit and is never printed, returned in JSON, sent to telemetry, or written through an intermediate `.env` or plist. Existing inline keys are compared with the selected application's key and never replaced on a mismatch.

An existing custom `Clerk.configure(...)` source is never migrated or rewritten. The developer must explicitly select the existing Clerk application it belongs to; agents do this with `--app <app_id>`. That choice authorizes linked-app and Native Application setup, but the CLI does not inspect the custom value or claim that it matches the selected application.

The CLI previews every planned local path and asks once before writing. Human users can pass `--yes` to skip that confirmation. Agent/non-TTY mode must pass `--yes` explicitly for native Apple mutations; agent mode never implies consent here. A planned file with existing Git changes is refused unless `--allow-dirty` is also explicit, and `--yes` does not imply `--allow-dirty`.

The package graph and direct Swift edits are prepared in memory, staged beside their destination files, committed together after exact app/key resolution, and re-inspected as one rollback-aware local transaction. Re-running an already-complete target is byte-for-byte a no-op. The command does not run Xcode, resolve package versions, build the app, edit `Package.resolved`, change signing, or request a secret key. XcodeGen and Tuist output is not edited; update the generator's source specification instead.

For iOS targets only, when every selected-target build configuration already points to a readable, target-exclusive XML entitlements file, `clerk init` can add the exact bare `webcredentials:<frontend-api-host>` value to all of those files. When every configuration is missing entitlements and the selected target has exactly one exclusive filesystem-synchronized source root, it can instead create a minimal `<target>/<target>.entitlements` file and attach it with iPhone-device and iPhone-simulator-qualified build settings. The CLI creates these qualified settings only after proving that every shipping target platform is iOS or macOS; a target that also ships visionOS is blocked before entitlement mutation. Existing files preserve unrelated entitlements, comments, newline style, and file modes, and all eligible entitlement changes commit in the same stale-input and rollback-aware transaction as the SDK and direct Swift edits. A `?mode=developer` entry is preserved but does not replace the bare entry. Mixed or conflicting entitlements paths, classic or shared destination ambiguity, generated projects, unresolved build settings, malformed or binary plists, and paths outside the invocation root remain review steps.

For macOS targets, `clerk init` verifies that an app using App Sandbox can make outgoing network connections. When the target can be updated safely, it enables the `com.apple.security.network.client` entitlement in every active macOS entitlements file, or creates and attaches a macOS entitlements file when the target has one exclusive filesystem-synchronized source root. An unsandboxed target requires no capability change. Conflicting, malformed, mixed, or unresolved sandbox and entitlements settings remain review steps.

The read-only output also includes a native-readiness section for the Bundle ID and literal App ID Prefix evidence, plus local Associated Domains coverage on iOS or App Sandbox outgoing-network coverage on macOS. Because `--dry-run` is strictly local-only, remote Native API and native application registration state is reported as `not-inspected`. A regular authenticated run audits those resources through the Platform API after the local preview.

If the linked development instance needs remote changes, `clerk init` prints a second, exact plan and asks separately before making them. Existing registrations are never updated or deleted. When a registration is missing, the CLI uses a consistently proven literal App ID Prefix, an explicit `--app-id-prefix`, or a human-entered value. If every selected-target configuration has the same valid `DEVELOPMENT_TEAM`, human mode offers it as a clearly labeled, unverified suggestion and lets the user enter a different prefix; it is never treated as proven evidence or selected non-interactively. Conflicting local evidence or an existing registration with a different prefix blocks before local files are committed. After consent, the guarded local transaction commits first, remote state is re-read, the exact native Apple registration is created, Native API is enabled last, and both resources are verified. Remote retries are additive and idempotent: if a remote step fails after local commit, local changes remain and rerunning safely reconciles the remaining work.

Native Sign in with Apple is an explicit opt-in, either through the human prompt or `--sign-in-with-apple`; `--yes` alone never enables it. The local transaction adds only `com.apple.developer.applesignin = ["Default"]` to every proven selected-target entitlements route. After the exact native Apple registration and Native API are ready, the CLI enables the Apple connection for that exact Bundle ID and verifies the final config. It neither asks for nor changes an Apple Services ID, Team ID, Key ID, or private key. Existing hosted Apple fields are preserved. With ClerkKitUI, `AuthView` displays Apple automatically; a custom flow can call `try await Clerk.shared.auth.signInWithApple()`.

The prebuilt authentication UI is also an explicit, independent opt-in. `--yes`, agent mode, ClerkKitUI linkage, and `--sign-in-with-apple` never select it by themselves. `--prebuilt-auth-ui` can rewrite only the exact untouched SwiftUI starter screen owned by the selected target; existing navigation, state, custom authentication, partial ClerkKitUI integrations, and established application content are preserved and reported as a review step. The generated screen matches the documented native-components quickstart: a `UserButton` signed-out entry presents `AuthView` in a sheet and prefetches Clerk images. It does not gate or replace established application content. Clerk's native components require iOS 17 or macOS 14 and the modern ClerkKit/ClerkKitUI products available in clerk-ios 1.0.0 or newer. Before committing an opted-in UI, the authenticated run also inspects the linked Frontend API environment without printing its publishable key; when Apple is already enabled and authenticatable, the same pre-authorized local transaction verifies or adds the required Apple entitlement without changing the remote Apple strategy.

## Agent Mode

When running in agent mode (`--mode agent` or non-TTY), the command runs the full init flow non-interactively:

- Confirmation prompts are generally auto-skipped, but changing a native Apple Xcode project requires an explicit `--yes`
- Native Apple remote mutations also require explicit `--yes`; when no existing registration or complete literal evidence supplies the App ID Prefix, pass `--app-id-prefix`
- Native Sign in with Apple additionally requires `--sign-in-with-apple`; `--yes` grants mutation consent but never opts a project into an authentication strategy
- The prebuilt native Apple authentication UI additionally requires `--prebuilt-auth-ui`; `--yes` and agent mode never opt into replacing even an eligible starter screen
- `init --dry-run` automatically emits structured JSON, even when `--json` is omitted
- For **existing projects**: framework and package manager are auto-detected, no flags required
- For **new projects** (`--starter` or blank directory): `--framework` is required (no way to auto-detect in an empty dir). Package manager is auto-selected by availability (bun → pnpm → yarn → npm) unless `--pm` is provided
- Project name defaults to the framework's default (e.g. `my-clerk-next-app`) unless `--name` is provided
- For keyless-capable frameworks with no `--app` and no linked profile:
  - When **authenticated**, init creates a real Clerk app named after the project (`package.json#name`, `--name`, or directory basename) and links it.
  - When **unauthenticated**, init uses keyless: the app runs on auto-generated dev keys, and init writes a `.clerk/keyless.json` breadcrumb so the next `clerk auth login` claims the app automatically.
- For frameworks that require API keys, agent mode normally requires `--app <id>` or an existing link. A safely inspectable fresh native Apple target is the exception: with valid credentials and explicit `--yes`, init can create and link the development application needed by the approved direct-source plan
- `--login` while unauthenticated exits with a usage error (agents can't complete the interactive browser login)
- Agent mode never trusts the mere _presence_ of a credential before native Apple mutation. A Platform API key is validated with a read-only application-list request, and a stored OAuth session must still resolve to a user. Invalid credentials stop native Apple setup before local apply. Elsewhere, a broken credential is treated as unauthenticated, which routes a keyless-capable framework to keyless instead of blocking on a browser OAuth round-trip an agent can never complete. If `--login` (or a real app target) forces the authenticated flow anyway and the credential turns out broken, init exits with a usage error instead of attempting an interactive login
- Agent mode never mints a fresh keyless application over an existing unclaimed one on re-run — see [Keyless breadcrumb](#keyless-breadcrumb)

## Flow

`--dry-run` first detects an existing native Apple project, performs the read-only inspection described above, prints its setup plan, and returns before authentication, linking, SDK installation, scaffolding, or any other setup work.

The normal setup flow is:

1. Gathers project context (framework, router variant, TypeScript, `src/` directory, package manager)
2. **Native Apple only**: validates native Apple-specific flags, resolves the current local Clerk profile, inspects the selected iOS or macOS target, and previews the complete redacted SDK plus Swift/runtime configuration plan. It obtains one aggregate consent but writes nothing. Agent credentials may be validated with a read-only API call before this preview so an invalid non-interactive invocation cannot proceed; interactive login, application selection/creation, key fetching, and every local write remain after consent
3. Determines the strategy (in precedence order). In agent mode, "authenticated" here means a _validated_ credential (a Platform API key accepted by a read-only PLAPI request, or a stored session that still exchanges for a valid token) — not just the presence of something in the keyring, since agent mode has no interactive fallback if a stale credential turns out to be unusable:
   - **`--keyless`**: forces keyless mode, even when logged in. Only valid on a keyless-capable framework, and cannot be combined with `--login` or `--app` (usage errors otherwise). The app runs on auto-generated dev keys; init writes a `.clerk/keyless.json` breadcrumb so the next `clerk auth login` claims the app automatically
   - **`--login`**: forces the authenticated flow. In agent mode while unauthenticated (or while stored credentials are broken) this exits with a usage error, since agents can't complete the interactive browser login
   - **Real app target** (`--app`, linked profile, or an approved fresh native Apple direct-source plan): authenticates and links if needed, then configures the native runtime directly or pulls API keys for frameworks that consume an env file
   - **Agent + non-keyless framework + no real app target**: scaffolds locally and prints manual setup instructions instead of selecting or creating an app
   - **Agent + keyless-capable framework + authenticated + no real app target**: creates a real Clerk app named after the project, links it, and pulls real API keys into `.env`
   - **Agent + keyless-capable framework + unauthenticated + no real app target**: uses keyless mode — the app runs on auto-generated dev keys and the breadcrumb lets the next `clerk auth login` claim it. A broken/stale stored credential (present in the keyring but no longer valid) is treated the same as unauthenticated, so this is also the fallback when the presence-only check would have wrongly said "authenticated"
   - **Human mode + bootstrap + keyless-capable framework + not authenticated**: uses keyless mode
   - **Human mode + existing project + not authenticated**: runs the authenticated flow, which triggers an interactive login so real keys can be pulled. `-y` does not bypass this — it only suppresses y/n confirmation prompts, not authentication
   - `--template` and `--fresh` are rejected with a usage error whenever the resolved strategy above isn't keyless — see [Application templates](#application-templates) and [Keyless breadcrumb](#keyless-breadcrumb)
4. **Authenticated mode only**: authenticates via `clerk auth login` (skipped if already authenticated) and links or creates/selects the project application via `clerk link`
5. **Eligible native Apple only**: resolves the explicitly selected application by its exact ID, fetches only its public development key, and audits Native API, native application registration, the selected prebuilt AuthView environment, and any explicitly requested native Apple connection before writing. It then prepares the approved PBX, Swift, and entitlements candidates again. A fresh target commits the eligible files through one rollback-aware transaction and re-inspects the result. This can include creating and attaching one platform-qualified entitlements file for an exclusive filesystem-synchronized target root, replacing only an explicitly selected pristine starter screen with the documented `UserButton` and `AuthView` sheet, adding the exact native Apple entitlement when required by either explicit Apple setup or an already-enabled Apple button, and enabling outgoing network access for a sandboxed macOS app. Custom key sources are preserved without inspection. The key is never resolved through mutable current-directory profile state, printed, or copied through dotenv. Additive remote Native Application changes run after the local commit; native Apple is enabled last and final state is re-read
6. Displays detected framework and variant
7. Detects existing auth libraries (NextAuth, Auth0, Supabase, Firebase, Passport, Better Auth, Kinde) and shows migration guidance
8. Installs the appropriate Clerk SDK (skips if already present)
9. Generates a scaffold plan for the detected framework
10. Warns if the git working tree has uncommitted changes
11. Previews planned file changes and asks for confirmation
12. Writes scaffold files to disk
13. Runs project formatters (Prettier/Biome) on generated files
14. Scans for issues: hardcoded keys, leftover auth-library imports, stale API calls
15. Prints a summary of created, modified, and skipped files with recommendations
16. **Authenticated mode**: pulls development instance API keys via `clerk env pull` for frameworks that consume dotenv files. Native Apple projects leave custom key storage unchanged
17. **Keyless mode** (unauthenticated runs whose resolved strategy in step 3 is keyless — an unauthenticated human-mode rerun on an existing project resolves to the authenticated flow instead): mints a keyless application and prints instructions for development without API keys and how to connect a Clerk account later — unless an unclaimed keyless app already exists for this project (see [Re-running init on an already-keyless project](#re-running-init-on-an-already-keyless-project)), in which case the existing keys are kept and reported instead
18. Optionally installs Clerk agent skills (cli + core + features, plus a framework-specific skill) via the project's package runner (see [Agent skills install](#agent-skills-install))

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

Native mobile platforms may not have a `package.json`, so they are detected from project marker files when no npm framework matches:

| Marker files                                                        | Framework            | Clerk SDK                                         | Publishable Key Env Var |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------------- | ----------------------- |
| `*.xcodeproj` / `*.xcworkspace`                                     | iOS or macOS (Swift) | `ClerkKit` + `ClerkKitUI` (Swift Package Manager) | `CLERK_PUBLISHABLE_KEY` |
| `app/src/main/AndroidManifest.xml` / `src/main/AndroidManifest.xml` | Android (Kotlin)     | `com.clerk:clerk-android-ui` (Gradle)             | `CLERK_PUBLISHABLE_KEY` |

A bare `Package.swift` or `build.gradle` is intentionally **not** enough — those also match server-side Swift packages and non-Android JVM projects. Native SDKs are not installed by a JavaScript package manager. For native Apple projects, init semantically identifies the selected iOS or macOS target and can edit its Swift Package Manager graph directly. The shared explicit framework selector remains `--framework ios`; target inspection determines the actual Apple platform. New and source-blank core-only integrations receive both ClerkKit and ClerkKitUI for the prebuilt authentication path; a source-proven custom integration stays ClerkKit-only. A safely inspectable fresh SwiftUI target is configured directly in its shipping `@main` source. Existing custom `Clerk.configure(...)` sources are preserved without interpreting how they load a key. Android still prints the Gradle installation steps.

The **Keyless** column indicates whether the framework's Clerk SDK supports keyless mode (auto-generated temporary dev keys). Keyless is the default for unauthenticated runs on Yes-row frameworks — during bootstrap (new projects) in human mode, and in all agent-mode runs. In human mode, an unauthenticated re-run in an existing project still triggers the authenticated flow. `--keyless` forces keyless anywhere a Yes-row framework is detected (existing projects included, even when logged in); passing it for a No-row framework exits with a usage error. In agent mode, an authenticated run on a keyless-capable framework creates a real app named after the project and links it.

Package manager is detected from lock files: `bun.lockb`/`bun.lock` → bun, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm, else npm.

## Scaffolding

Scaffolding is supported for every detected framework. The dedicated native Apple preflight may safely update the selected iOS or macOS Xcode target's Swift package graph, direct configuration, and platform-specific capabilities before generic scaffolding; custom key sources are preserved and require explicit application selection. Remaining native Apple work and all Android native setup are printed as post-instructions.

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

For iOS and macOS, the dedicated setup phase links both `ClerkKit` and `ClerkKitUI` for a fresh target so the optional prebuilt authentication path is available. It also upgrades a source-blank target left ClerkKit-only by an earlier setup, while preserving a source-proven ClerkKit-only custom flow. A safely inspectable fresh SwiftUI target receives direct `@main` Clerk configuration and environment injection; custom configuration sources remain unchanged and require explicit application selection. With explicit `--prebuilt-auth-ui` consent, only an exact untouched SwiftUI starter screen can receive the quickstart `UserButton`, image prefetching, and `AuthView` sheet; established UI is never rewritten. On iOS only, safe XML entitlements files can receive the selected application's exact Associated Domain transactionally, and a modern target with one exclusive filesystem-synchronized source root can receive a new iOS-only entitlements file. On macOS, setup verifies the App Sandbox outgoing-network capability and can add `com.apple.security.network.client` safely when required. The authenticated phase then audits and, with separate consent, additively creates the exact native Apple registration and enables Native API for the selected development instance. The optional `--sign-in-with-apple` path composes the native Apple entitlement into that transaction and enables only the exact Bundle ID's Clerk Apple connection. Android prints the Gradle SDK step for `com.clerk:clerk-android-*`.

## Agent skills install

After scaffolding (and after env keys are pulled or keyless instructions are printed), `clerk init` offers to install Clerk's agent skills via the [`skills`](https://www.npmjs.com/package/skills) CLI. The runner is detected from the project's package manager (`bunx`, `npx`, `pnpm dlx`, or `yarn dlx`), so a Bun project installs via `bunx skills add ...`, a pnpm project via `pnpm dlx skills add ...`, and so on. This step is optional and non-fatal: if no package runner is available on PATH or an install command exits non-zero, init prints a yellow warning with a runner-appropriate manual command and still exits successfully.

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

| Step                   | Method | Base URL                        | Endpoint                       | Description                                                                                                                           |
| ---------------------- | ------ | ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Create accountless app | `POST` | `CLERK_BAPI_URL` (default BAPI) | `/v1/accountless_applications` | Creates a temporary keyless Clerk application; returns `publishable_key`, `secret_key`, and `claim_url`. Only called in keyless mode. |

See [auth/README.md](../auth/README.md), [link/README.md](../link/README.md), and [env/README.md](../env/README.md) for the API endpoints used by each step.

## Application templates

`--template <name>` is forwarded to `POST /v1/accountless_applications`, which pre-configures the application server-side before the first key is used. This is the one-shot way for an agent to get a shaped instance without an account — a `b2b-saas` keyless app comes back with organizations already enabled, where a default one does not.

| Template   | Shape                            |
| ---------- | -------------------------------- |
| `b2b-saas` | Organizations-first B2B setup    |
| `b2c-saas` | Consumer setup with user billing |
| `native`   | Native/mobile application        |
| `waitlist` | Waitlist sign-up mode            |

The template only applies when a _new_ application is actually created, so `--template` is rejected with a usage error whenever the resolved strategy isn't keyless — whether that's because of an explicit conflicting flag (`--login`, or `--app` once the strategy resolves) or because the run is simply already authenticated (e.g. `CLERK_PLATFORM_API_KEY` is set) or the framework doesn't support keyless at all. The error names the reason, so `--template` is never silently dropped: add `--keyless` to force a keyless app, or drop `--template`. Settings can still be changed afterwards with `clerk config patch`, which also works without an account (see [config keyless mode](../config/README.md#keyless-mode)).

## Keyless breadcrumb

In keyless mode, after calling `POST /v1/accountless_applications`, `clerk init` writes `.clerk/keyless.json` to the project root. This file records the claim token extracted from `claim_url` so that `clerk auth login` can automatically claim the temporary application the next time the user authenticates.

```json
{
  "claimToken": "<token>",
  "createdAt": "<ISO timestamp>"
}
```

`.clerk/` is automatically added to `.gitignore` when the breadcrumb is written. The breadcrumb is removed after a successful claim (or when the claim token expires/is already consumed).

### Re-running init on an already-keyless project

The breadcrumb is also what protects an unclaimed keyless app from being orphaned by a later `clerk init` run. As long as `.clerk/keyless.json` is present, the application it points at hasn't been claimed yet. The application and everything configured on it keep existing server-side either way — what the breadcrumb and env keys hold is the only local way to claim or reach it, so overwriting them can strand an application that still has configuration or users on it. So whenever init resolves to keyless mode and finds an existing breadcrumb, it does **not** silently mint a replacement application and overwrite the env keys and breadcrumb with the new one's:

- **Human mode** (no `-y`): prompts `This project already has an unclaimed keyless application (created <date>). Replace it with a new one?`, defaulting to **no**. Declining keeps the existing keys and breadcrumb untouched.
- **Human mode with `-y`, and all agent-mode runs**: never prompt, and default to the same safe answer — **keep the existing application**. `-y` and agent mode both mean "skip confirmations", not "consent to destroying an app that might already have configuration or users on it".
- **`--fresh`**: the explicit escape hatch. Skips the check entirely and mints a new application (and overwrites the env keys and breadcrumb), even in agent mode or with `-y`. Like `--template`, it's a usage error when combined with `--login` or whenever the run doesn't resolve to keyless.

If no breadcrumb exists (first run, or the previous app was already claimed and the breadcrumb removed), init proceeds exactly as before — there's nothing to protect.
