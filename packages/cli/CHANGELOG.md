# clerk

## 2.2.0

### Minor Changes

- Revoke live impersonation sessions with `clerk imp revoke <act_id> --user <user_id>`. When the actor token was already accepted (the sign-in URL was opened), the token itself can no longer be revoked — the command now falls back to finding and revoking the active session(s) your impersonation created. The "Revoke with" hint printed by `clerk imp` includes `--user` so the command works in both states. ([#382](https://github.com/clerk/cli/pull/382)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 2.1.0

### Minor Changes

- Guide you to the billing page to add the impersonation add-on when `clerk impersonate` is blocked by your plan (402) or your billing-period limit (422). In an interactive terminal it offers to open the page for you; `--yes` opens it directly, `--print` and agent mode surface the URL without opening a browser. ([#376](https://github.com/clerk/cli/pull/376)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 2.0.1

### Patch Changes

- Prevent `clerk init` from executing an attacker-planted `node_modules/.bin/{prettier,biome,skills}` binary from the project being set up. The formatter and skills steps now pin the package runner to the registry (`bunx --package <pkg>@latest -- …`, and the pnpm/yarn `dlx` equivalents) so it runs the real tool instead of a project-local bin shadow. ([#377](https://github.com/clerk/cli/pull/377)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 2.0.0

### Major Changes

- Remove the bundled `clerk skill install` command and install the `clerk-cli` agent skill from the [`clerk/skills`](https://github.com/clerk/skills) repository during `clerk init`. ([#315](https://github.com/clerk/cli/pull/315)) by [@wyattjoh](https://github.com/wyattjoh)

### Minor Changes

- Add `clerk api --fapi` to call an instance's public Frontend API (e.g. `clerk api --fapi /environment --app <id>`). The FAPI host is resolved from the instance's publishable key, and the request is unauthenticated since these endpoints are public, which closes the loop on verifying config changes end to end with the CLI alone. ([#345](https://github.com/clerk/cli/pull/345)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Refresh the visual style of prompts, lists, spinners, and intro/outro brackets to use `@clack/prompts`, and make interactive command endings reflect success, failure, or paused cancellation status. ([#305](https://github.com/clerk/cli/pull/305)) by [@wyattjoh](https://github.com/wyattjoh)

- Add `clerk impersonate` (alias `clerk imp`) to create a short-lived sign-in URL that logs you in as another user, plus `clerk impersonate revoke` to cancel a pending token. Both require `clerk login` and stamp the impersonation with your account for auditing. ([#373](https://github.com/clerk/cli/pull/373)) by [@rafa-thayto](https://github.com/rafa-thayto)

- `clerk init` on Expo projects now installs the `clerk-expo` agent skill (Expo/React Native setup) alongside `clerk-expo-patterns`. The framework skill map supports multiple skills per framework. ([#328](https://github.com/clerk/cli/pull/328)) by [@manovotny](https://github.com/manovotny)

- Render the "Next steps" header in a dusty mauve and sweep a white reflex highlight across it once after `clerk deploy`, `clerk link`, and `clerk auth login`, then settle on the flat color. The animation only runs on an interactive color terminal and falls back to plain styling when piped, in CI, or when `NO_COLOR` is set. ([#322](https://github.com/clerk/cli/pull/322)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Add the `clerk webhooks` command group (V1): a PLAPI-free local webhooks toolkit. ([#366](https://github.com/clerk/cli/pull/366)) by [@rafa-thayto](https://github.com/rafa-thayto)

  - `clerk webhooks listen` — open a standalone Svix relay tunnel and forward deliveries to a local handler. No auth, no linked project, no backend. `--forward-to` is required. Without `--token`, the banner warns that the auto-generated relay token isn't a guaranteed-stable handle and prints the exact `--token` to pin next time; `--token <c_…>` pins an explicit, shareable URL. Flags: `--forward-to` (required), `--token`, `--headers`, `--json`. When `--forward-to` is missing, the usage error prints a runnable example beneath it.
  - `clerk webhooks verify` — verify a webhook signature offline (HMAC-SHA256), from a saved `listen` event line (`--delivery`) or the four explicit header values. No network calls.
  - `clerk webhooks token` — generate a valid relay token (`c_` + 10 base62 chars) for `listen --token`. Prints the bare token to stdout so it pipes: `clerk webhooks listen --token "$(clerk webhooks token)"`.

### Patch Changes

- Keep a separator between the path and description in `clerk api ls` so long endpoint paths no longer run straight into their summaries. ([#340](https://github.com/clerk/cli/pull/340)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix the OAuth provider walkthrough in `clerk deploy` printing the redirect URI on the wrong subdomain. Previously, the walkthrough showed `https://accounts.{domain}/v1/oauth_callback`, but the callback is served by the Frontend API, so pasting the value into a provider console caused `redirect_uri_mismatch`. The walkthrough now prints the instance's `frontend_api_url` (e.g. `https://clerk.{domain}/v1/oauth_callback`), matching the value shown in the Clerk Dashboard. ([#335](https://github.com/clerk/cli/pull/335)) by [@Railly](https://github.com/Railly)

- Only read stdin as `--input-json` when `--input-json -` is passed explicitly. Previously any piped stdin was consumed and parsed as the options payload, which broke shell loops (`while read … | clerk …`) and commands that read their own stdin (`cat body.json | clerk api …`) with a confusing `invalid_json` error. ([#341](https://github.com/clerk/cli/pull/341)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Resolve the instance explicitly instead of silently defaulting to development: interactive flows (`clerk impersonate`, `clerk impersonate revoke`, `clerk users open`, the create wizard, and the application-picker fallback) now ask in human mode whenever the resolved app has more than one instance and no `--instance` flag pins one, and agent mode errors asking for an explicit `--instance` rather than defaulting — so the same command can't resolve a different instance depending on which instances the app happens to have. User lookups that find no match name the searched app and instance in the error, and instances targeted by raw ID are labeled by their environment type so the production impersonation warning always fires. ([#373](https://github.com/clerk/cli/pull/373)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Print the "Next steps" list before sweeping the highlight across its header, so the animation no longer leaves a lone "Next steps" line that looks hung while the steps are hidden. ([#343](https://github.com/clerk/cli/pull/343)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `clerk init` for React Router v8 projects by adding `@clerk/react-router` to `ssr.noExternal` in the Vite config, preventing dev-mode SSR from failing with "useNavigate() may be used only in the context of a <Router>". ([#374](https://github.com/clerk/cli/pull/374)) by [@manovotny](https://github.com/manovotny)

- Stop showing the "possible sandboxed run" hint for ordinary network failures (unreachable host, VPN, DNS) in agent mode. The hint now requires a permission-like error before suggesting a sandbox, and is a single line. ([#342](https://github.com/clerk/cli/pull/342)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 1.5.0

### Minor Changes

- Add `clerk deploy status`, a read-only command that verifies a production deploy, including DNS, SSL, email DNS, and OAuth credential completeness. Agent-mode `clerk deploy` now emits a tailored read-only handoff instead of a hard usage error. ([#260](https://github.com/clerk/cli/pull/260)) by [@wyattjoh](https://github.com/wyattjoh)

- Add `clerk deploy`, an interactive wizard that promotes a Clerk application from development to production. ([#260](https://github.com/clerk/cli/pull/260)) by [@wyattjoh](https://github.com/wyattjoh)
  - Walks through cloning the development instance, creating the production instance, and configuring CNAME records.
  - Verifies mail, DNS, and SSL one component at a time so each step's status is visible while polling.
  - Optionally exports the DNS records as a BIND zone file at `./clerk-<domain>.zone` for import into providers like Cloudflare, Route 53, and Google Cloud DNS.
  - Resumes from the next pending step on subsequent runs, including reshowing the CNAME records when DNS is not yet verified.
  - Uses provider schemas to collect production OAuth credentials for broader built-in provider support.
  - Returns users to credential choices after opening provider docs, including Google JSON import when supported.

## 1.4.0

### Minor Changes

- Show the linked Clerk application in `clerk whoami` output, and add a `--json` flag that emits a structured payload covering email and link state. ([#265](https://github.com/clerk/cli/pull/265)) by [@rafa-thayto](https://github.com/rafa-thayto)

### Patch Changes

- Add a local leaderboard to the hidden `clerk bird` easter egg: from the GAME OVER screen, press `N` to enter your name and `L` to view the top scores. On the leaderboard, use `↑`/`↓` (or `j`/`k`) to select a row and `D` to delete it (with `Y`/`N` confirmation). `k` now also flaps in-game, alongside `SPACE`, `↑`, `W`, and `ENTER`. Rankings are stored as JSON in `~/.flap-rankings.json` (top 10, ties broken by older entry). The existing `~/.flap-best` file is unchanged. Pipe-passes and the death event now emit a short bell tone (ASCII BEL) so the `+1` and the GAME OVER moment each have audio feedback; terminals with the bell disabled stay silent and the host terminal handles cross-platform behavior on Windows, macOS, Linux, and any POSIX TTY. The `bird` command is no longer hidden and now appears at the bottom of `clerk --help` (after the `help` row) so the easter egg is discoverable without cluttering the main command surface. ([#304](https://github.com/clerk/cli/pull/304)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Harden the dependency-install step of `clerk init`. Previously, the package-manager spawn in attacker-controlled cwd could execute arbitrary JavaScript via pnpm's `.pnpmfile.cjs` autoload or via lifecycle scripts (`preinstall`/`install`/`postinstall`) in the project's `package.json`. The install command now passes `--ignore-pnpmfile` (pnpm) and `--ignore-scripts` (all package managers). ([#302](https://github.com/clerk/cli/pull/302)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Identify the CLI in outbound HTTP requests with a `User-Agent` like `Clerk-CLI/<version> (Bun/<bun-version>; <platform>-<arch>)` instead of the default Bun user agent. Allow callers to override the header. ([#301](https://github.com/clerk/cli/pull/301)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 1.3.0

### Minor Changes

- Accept plural `orgs` and `users` as the canonical values for `--for` on `clerk enable billing` and `clerk disable billing`. The singular `org` and `user` continue to work as aliases. ([#274](https://github.com/clerk/cli/pull/274)) by [@kylemac](https://github.com/kylemac)

- Add `-y` / `--yes` to `clerk auth login` and `clerk login` to suppress prompt "You're already logged in... Re-Authenticate?" ([#272](https://github.com/clerk/cli/pull/272)) by [@jfoshee](https://github.com/jfoshee)

### Patch Changes

- Disable `bunfig.toml` autoload in the compiled CLI binary. Previously, an attacker-supplied `bunfig.toml` in the current working directory could execute arbitrary JavaScript (via `preload`) before argv parsing on any `clerk` invocation — including `clerk --version` and unknown subcommands. The release and local compile scripts now pass `--no-compile-autoload-bunfig` to `bun build --compile`, mirroring the existing `--no-compile-autoload-dotenv` hardening. ([#292](https://github.com/clerk/cli/pull/292)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 1.2.0

### Minor Changes

- Make keyless mode opt-in via a new `--keyless` flag on `clerk init`. Previously, `clerk init` on a keyless-capable framework (Next.js, Astro, Nuxt, TanStack Start, React Router) would silently fall back to auto-generated temporary dev keys whenever the user wasn't authenticated. The default now triggers `clerk auth login` and links a real Clerk application. ([#268](https://github.com/clerk/cli/pull/268)) by [@rafa-thayto](https://github.com/rafa-thayto)
  - `clerk init` (default): authenticates and links a real app.
  - `clerk init --keyless`: scaffolds with auto-generated dev keys; the user can run `clerk auth login` later to claim the temporary application.
  - `clerk init --keyless` on a non-keyless framework exits with a usage error rather than silently ignoring the flag.
  - `clerk init -y` no longer bypasses authentication. `-y` only skips y/n confirmation prompts; without `--keyless`, an unauthenticated user is still prompted to log in via the browser.
  - Agent-mode `clerk init` without authentication and without `--keyless` (or `--app`) prints manual setup guidance instead of generating dev keys, since agents cannot run interactive OAuth.

### Patch Changes

- Fix shell detection for fish users whose login shell is zsh. `clerk doctor` now correctly identifies fish via `FISH_VERSION`, and `clerk update` no longer shows an irrelevant `hash -r` hint. ([#264](https://github.com/clerk/cli/pull/264)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `clerk env pull --file <path>` to honor absolute paths. Previously, absolute paths were silently nested under the current working directory (e.g. `--file /Users/u/clerk-dev.env` wrote to `<cwd>/Users/u/clerk-dev.env`), making the file appear missing at the expected location while the success message claimed it was written there. Both absolute and relative paths now resolve correctly. ([#270](https://github.com/clerk/cli/pull/270)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Show contextual next-step suggestions after `clerk auth logout`, `clerk switch-env`, `clerk unlink`, `clerk whoami`, `clerk completion`, `clerk skill install`, `clerk config patch`, and `clerk config put` to point users to the natural follow-up action. ([#250](https://github.com/clerk/cli/pull/250)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 1.1.1

### Patch Changes

- Fix `clerk init --framework` in empty directories skipping project scaffolding and only writing Clerk-specific files. ([#256](https://github.com/clerk/cli/pull/256)) by [@alexcarpenter](https://github.com/alexcarpenter)

- `clerk init --starter` now installs `@clerk/nuxt@latest` for new Nuxt projects instead of the pinned `@clerk/nuxt@2.2.0-snapshot.v20260413174426`. Keyless support shipped in stable `@clerk/nuxt@2.2.0`, so the snapshot pin (originally a workaround) is no longer needed. ([#257](https://github.com/clerk/cli/pull/257)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 1.1.0

### Minor Changes

- `clerk init` in agent mode now creates and links a real Clerk application when the user is authenticated, instead of falling back to keyless setup. Keyless still runs in agent mode when the user is not authenticated, but authenticated agent runs leave the project properly linked with real development keys in `.env`. ([#254](https://github.com/clerk/cli/pull/254)) by [@wyattjoh](https://github.com/wyattjoh)

- Add `clerk enable` and `clerk disable` top-level commands for toggling features on the linked instance. ([#219](https://github.com/clerk/cli/pull/219)) by [@nicolas-angelo](https://github.com/nicolas-angelo)

  - `clerk enable orgs` / `clerk disable orgs` — toggle organizations, with `--force-selection`, `--auto-create`, `--max-members <n>`, and `--domains` on enable.
  - `clerk enable billing [--for org,user]` / `clerk disable billing [--for org,user]` — toggle billing for organizations and/or users. `--for` defaults to both; enabling for `org` cascades to enabling organizations. Enable also offers to install the `clerk-billing` agent skill (suppress with `--no-skills`).

- Add `--input-json` to pass options as JSON for any command. Accepts an inline object or `@path/to/file.json`; keys are converted from camelCase/snake_case to kebab-case flags (e.g. `{"dryRun":true}` → `--dry-run`). Arrays expand to repeated flags, `true` becomes a bare flag, `false`/`null` are omitted. Designed for AI-agent and scripted invocations that prefer passing structured options over composing shell strings. ([#232](https://github.com/clerk/cli/pull/232)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Remove `clerk init --prompt` and the bundled per-framework agent prompt templates. Agents should run `clerk init -y` to perform the full setup non-interactively, or run `skills add clerk/skills` directly via their preferred package runner. The internal `pmInstallCommand` helper has moved from `commands/init/prompts/` to `lib/package-manager.ts`. ([#241](https://github.com/clerk/cli/pull/241)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Rename the bundled agent skill from `clerk` to `clerk-cli` for more clarity during install. After upgrading, `clerk skill install` (and the install step in `clerk init`) writes the skill to `<agent-dir>/skills/clerk-cli/` instead of `<agent-dir>/skills/clerk/`. Existing `skills/clerk/` directories from prior installs are left in place; remove them manually if you want to avoid duplicate context. ([#245](https://github.com/clerk/cli/pull/245)) by [@kylemac](https://github.com/kylemac)

- Add direct user-management commands to `clerk users`: ([#237](https://github.com/clerk/cli/pull/237)) by [@wyattjoh](https://github.com/wyattjoh)

  - `clerk users list` with pagination, query search, repeatable identifier filters (`--email-address`, `--phone-number`, `--username`, `--user-id`, `--external-id`), `--order-by` over Clerk's common user ordering fields, and an application picker when invoked without a linked project, env var, or targeting flag. `--limit` defaults to 100 and accepts 1-250. `--json` (and agent mode) emits `{ data, hasMore }` so callers can paginate without a separate count call; the human-mode table footer surfaces the next `--offset` when more pages are available. The interactive user picker (used by `clerk users open` and other update flows) shows a "More results, refine your search" hint when matches overflow its window.
  - `clerk users open [user-id]` for opening a user's Clerk dashboard page in the browser, with interactive pickers for the application and the user, plus `--print` for emitting the URL.

  Both commands appear in the interactive `clerk users` menu.

- Add `clerk users` command scaffolding with `clerk users create`, plus an interactive mode for the `users` family. The create wizard reads instance settings from the Frontend API to prompt only for enabled fields, marking required ones. A top-level interactive menu (`clerk users` with no subcommand) routes to registered actions; agent mode preserves the strict flag-driven contract. The application picker (used by `clerk link` and the `clerk users` wizard fallback) now lists the "Create a new application" option at the bottom and de-emphasizes it until highlighted, so it reads as a fallback rather than a primary choice. ([#240](https://github.com/clerk/cli/pull/240)) by [@wyattjoh](https://github.com/wyattjoh)

### Patch Changes

- Allow `clerk init` to run in agent mode without requiring `--app`. For keyless-capable frameworks, agent init now uses keyless setup when no real Clerk app target is provided; explicit `--app` or an existing linked profile still uses the authenticated app-linking flow, including the normal login fallback when needed. Agent init no longer creates, auto-selects, or auto-links a Clerk application when no app target is provided. ([#244](https://github.com/clerk/cli/pull/244)) by [@djgould](https://github.com/djgould)

- Reduce the size of the published `clerk` binary and JS bundle by enabling minification during the build. The compiled binary shrinks by ~1 MB across all platforms, and the bundled `cli.js` artifact shrinks by ~41% (2.37 MB → 1.40 MB), with no change to behavior. ([#251](https://github.com/clerk/cli/pull/251)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Avoid deleting refreshed OAuth credentials when parallel CLI processes race to refresh the same expired session. ([#213](https://github.com/clerk/cli/pull/213)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix `clerk update` hanging when a corepack-shimmed package manager (e.g. yarn) prompts on stdin to download itself on first use. Package-manager probes now run with stdin detached, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, and a 1.5s timeout, so a missing or uninitialized PM is treated as not installed instead of blocking the command. ([#243](https://github.com/clerk/cli/pull/243)) by [@dmoerner](https://github.com/dmoerner)

- After `clerk auth login`, the OAuth success page now points users to Clerk Skills with a copyable install command and a link to the AI building guide. ([#238](https://github.com/clerk/cli/pull/238)) by [@Railly](https://github.com/Railly)

- Auto-increment the default project name in `clerk init` when a directory with that name already exists, and re-prompt instead of erroring out when the chosen name collides. ([#252](https://github.com/clerk/cli/pull/252)) by [@dmoerner](https://github.com/dmoerner)

## 1.0.3

### Patch Changes

- Improve Clerk CLI behavior for sandboxed agent runs. ([#226](https://github.com/clerk/cli/pull/226)) by [@wyattjoh](https://github.com/wyattjoh)

  The CLI now warns once per invocation when host-only Clerk state or system
  capabilities are unavailable in agent mode, which helps distinguish real auth
  and linking failures from sandbox-induced ones. `clerk doctor` also includes a
  `Host execution` check in agent mode so the sandbox condition is visible in
  structured diagnostics.

  This release also updates the bundled Clerk skill docs to explain the warning,
  when to rerun commands on the host, and how sandboxed agent runs can misreport
  auth, linking, env, and API failures.

- Teach agents the `+clerk_test` email suffix and the US fictional-phone range (`+1 (XXX) 555-0100` through `+1 (XXX) 555-0199`), paired with the fixed `424242` OTP, for creating test users that bypass client trust in development. The pattern is documented in the bundled skill's recipes and every `clerk init --prompt` handoff. ([#227](https://github.com/clerk/cli/pull/227)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix `clerk update` to upgrade the binary that is actually running. With multiple installs on the same machine (e.g. bun and asdf-npm), the command now picks the install that owns the currently-running `clerk` as the primary target instead of the first `PATH` match, so `clerk -v` reflects the upgrade without needing `--all`. ([#230](https://github.com/clerk/cli/pull/230)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `clerk doctor` falsely reporting the CLI config file as missing. The check was looking at a legacy path (`~/.clerk/config.json`) instead of the platform-appropriate location used by the rest of the CLI. ([#220](https://github.com/clerk/cli/pull/220)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Move the "Create a new application" option to the top of the `clerk link` picker so it's visible without scrolling. ([#221](https://github.com/clerk/cli/pull/221)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `clerk login` on Windows failing to open the OAuth URL when query parameters contain ampersands. ([#222](https://github.com/clerk/cli/pull/222)) by [@alexcarpenter](https://github.com/alexcarpenter)

## 1.0.2

### Patch Changes

- fixed readme publishing on npm ([#217](https://github.com/clerk/cli/pull/217)) by [@wyattjoh](https://github.com/wyattjoh)

## 1.0.1

### Patch Changes

- Fix the stable release Homebrew publish step so it awaits each release upload and tap repository command before moving to the next step. This prevents the Homebrew workflow from racing past `gh release upload`, `git clone`, and the follow-up git operations while publishing a release. ([#214](https://github.com/clerk/cli/pull/214)) by [@wyattjoh](https://github.com/wyattjoh)

## 1.0.0

### Major Changes

- Release Clerk CLI 1.0 as the first stable `1.x` line. ([#199](https://github.com/clerk/cli/pull/199)) by [@wyattjoh](https://github.com/wyattjoh)

  This milestone rolls up the recent improvements to bootstrap flows, authentication and keyless claiming, bundled agent skills, PATH-aware updates, interactive prompts, and docs into a stable baseline for the standalone `clerk` CLI.

### Minor Changes

- Automatically claim and link keyless applications on `clerk auth login`, and write temporary dev keys during `clerk init` when skipping authentication. ([#157](https://github.com/clerk/cli/pull/157)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Add `clerk skill install` to install the bundled `clerk` Claude Code skill into your project. The skill ships with the CLI and is pinned to the CLI's version, and `clerk init` now offers to install it alongside the framework-pattern skills. ([#126](https://github.com/clerk/cli/pull/126)) by [@wyattjoh](https://github.com/wyattjoh)

  The bundled skill's command reference and agent-mode docs have also been resynced with the CLI: `clerk init --app`, `clerk config patch`/`put` `--app` and `--instance`, and `clerk update` are now documented, agent-mode errors are documented as structured JSON on stderr, the `clerk doctor --json` shape is spelled out in full (`detail`, `fix` alongside `remedy`), `apps create` is noted as auto-emitting JSON in agent mode (same as `apps list`), and the OpenAPI catalog cache TTL is corrected to 1 hour. The auth docs now list the `signup`/`signin`/`sign-in` and `signout`/`sign-out` aliases plus the top-level `clerk login`/`clerk logout` shortcuts, `config patch` explains `--destructive` the same way `config put` does, `config` commands are noted as Platform-API-only (they ignore `--secret-key`), and the agent-mode reference maps each failing `clerk doctor` check to the manual command that would remediate it when `--fix` is unavailable. Hardcoded `~/.clerk/config.json` and `~/.clerk/cache/` paths are replaced with platform-agnostic guidance (run `clerk doctor --verbose` to see resolved paths; override with `CLERK_CONFIG_DIR`), and `CLERK_CONFIG_DIR` is added to the environment variables table.

- Fix `clerk update` silently writing to the wrong installer when multiple `clerk` binaries exist on PATH. The command now walks PATH to identify the binary the user's shell will actually execute, determines which installer owns that specific path (via a new `ownerOfBinary()` check), and runs the corresponding installer. Binaries installed outside any known package manager (e.g. via `install.sh`) are refused with reinstall guidance rather than silently updated via npm. Also fixes bun detection, which previously matched the shim dir (`~/.bun/bin`) instead of the install dir (`~/.bun/install/global/node_modules`) and fell through to the npm fallback. Adds a `--all` flag to update every `clerk` install on PATH in one run, skipping Homebrew on non-stable channels and unknown-owner binaries with a warning. Prints a `hash -r` / `rehash` hint based on `$SHELL` after a successful update. ([#179](https://github.com/clerk/cli/pull/179)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Stamp authenticated CLI app creation with `from_source=cli` so apps created through Clerk CLI flows are attributable in Clerk's analytics. The value is set on the PLAPI request body and persists to `applications.from_source`. Requires matching PLAPI support to be deployed server-side. ([#192](https://github.com/clerk/cli/pull/192)) by [@mwickett](https://github.com/mwickett)

- Add scroll indicators ("↑ N more above" / "↓ N more below") to interactive list prompts when choices overflow the visible page. Add interactive environment picker to `clerk switch-env` when no argument is given. ([#176](https://github.com/clerk/cli/pull/176)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Refresh expired OAuth sessions automatically for authenticated CLI commands. ([#205](https://github.com/clerk/cli/pull/205)) by [@wyattjoh](https://github.com/wyattjoh)

### Patch Changes

- Fix agent-mode linking flows. `clerk link --app <id>` now works non-interactively in agent mode, `clerk link` without `--app` tries deterministic autolink before failing with a usage error, and `clerk unlink --yes` now unlinks instead of printing guidance. The bundled `skills/clerk` docs were updated to match the new agent-mode behavior. ([#212](https://github.com/clerk/cli/pull/212)) by [@wyattjoh](https://github.com/wyattjoh)

- Accept comma-separated values for `--keys` in `config pull` and `config schema`, and clarify that keys refer to top-level config sections. ([#187](https://github.com/clerk/cli/pull/187)) by [@dmoerner](https://github.com/dmoerner)

- Prevent local unsigned macOS builds from sharing the release keychain entry. ([#201](https://github.com/clerk/cli/pull/201)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix shell completion install tips so they work on fresh systems. The `clerk doctor` zsh remedy now leads with `eval "$(clerk completion zsh)"` and points to `clerk completion --help` for the file-based install method, and the fish remedy prefixes `mkdir -p ~/.config/fish/completions` before writing. The zsh completion script's install banner now tells users to `mkdir -p ~/.zfunc` before writing the completion file. ([#206](https://github.com/clerk/cli/pull/206)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Default `clerk env pull` to `.env.local` on Next.js projects with no existing env file, matching the framework's convention for local secrets. Projects that already have keys in `.env` continue to write there. ([#204](https://github.com/clerk/cli/pull/204)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix link saving to wrong directory during bootstrap flow. When creating a new project via `clerk init`, the Clerk application link is now correctly saved to the new project directory instead of the parent directory. ([#186](https://github.com/clerk/cli/pull/186)) by [@kylemac](https://github.com/kylemac)

- Store macOS credentials in the system Keychain instead of a plaintext file. ([#198](https://github.com/clerk/cli/pull/198)) by [@wyattjoh](https://github.com/wyattjoh)

  - Previously, macOS builds silently stored the OAuth token in `~/Library/Application Support/clerk-cli/credentials` because cross-compiled binaries were missing the native Keychain binding.
  - Run `clerk login` after upgrading so the CLI writes a fresh token into the Keychain and removes the old plaintext file.

- Surface the bundled agent skill in `clerk --help` and bare `clerk` output with a tip pointing to `clerk skill install`, so users discover how to give AI coding agents Clerk context. ([#191](https://github.com/clerk/cli/pull/191)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Tighten the `clerk init` bootstrap flow: ([#184](https://github.com/clerk/cli/pull/184)) by [@rafa-thayto](https://github.com/rafa-thayto)

  - Skip the redundant "Proceed?" scaffold confirmation when bootstrapping a new project (via `--starter` or on an empty directory). The scaffold plan is still previewed; only the now-superfluous prompt is removed since the user already opted in by starting bootstrap.
  - Print bootstrap next steps (`cd <project>`, `<pm> dev`, etc.) after the optional "Install agent skills?" prompt so they remain the last thing visible when the command finishes.

- Fix `clerk init` bootstrap flow failing with "No Clerk project linked to this directory" when pulling API keys into a newly created project subdirectory. ([#195](https://github.com/clerk/cli/pull/195)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `install.sh --install-dir <path>` so it creates the directory when it does not already exist, matching the behavior of the `~/.local/bin` fallback. ([#202](https://github.com/clerk/cli/pull/202)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix `clerk init` prompt flow: ([#175](https://github.com/clerk/cli/pull/175)) by [@rafa-thayto](https://github.com/rafa-thayto)

  - When you are signed in (OAuth or `CLERK_PLATFORM_API_KEY`), `clerk init` skips straight to the authenticated flow — no more "Skip authentication for now?" prompt.
  - When you are not signed in **during bootstrap** (new projects) on a keyless-capable framework, `clerk init` now goes keyless automatically (previously prompted) and points you to `clerk auth login` for later. Re-runs in an existing project still fall through to the authenticated flow so real keys can be pulled.
  - Keep `clerk init --starter` fully interactive — it no longer fails with "Non-interactive mode requires --framework" when running without `-y`.

- Run `config patch --dry-run` and `config put --dry-run` against the server when changes are detected, so validation errors are caught and the projected configuration (including any server-applied defaults) is returned before changes are committed. ([#200](https://github.com/clerk/cli/pull/200)) by [@dmoerner](https://github.com/dmoerner)

- Install the full Clerk core and feature skill sets by default during `clerk init`. Agents now get context for `clerk-custom-ui`, `clerk-backend-api`, `clerk-orgs`, `clerk-testing`, and `clerk-webhooks` in addition to the previous defaults, plus a framework-specific skill when one matches. Pass `--no-skills` to opt out. ([#185](https://github.com/clerk/cli/pull/185)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Expand `--verbose` debug output across the CLI and surface silent environment fallbacks. ([#183](https://github.com/clerk/cli/pull/183)) by [@wyattjoh](https://github.com/wyattjoh)

  - Every outbound HTTP call (platform API, backend API, OAuth, npm registry) now logs its URL, method, status, and response body on error under `--verbose`.
  - New debug coverage for the credential store, config file I/O, environment resolution, auth callback server, git detection, framework detection, autolink, and package-manager runner probing.
  - Warn without `--verbose` when the saved environment is not available in the current binary, instead of silently falling back to production.

- Document the `--all` flag for `clerk update` in the bundled Clerk agent skill's command reference table. The flag was already implemented but missing from the skill, so agents couldn't help users with multiple clerk installs on PATH. ([#196](https://github.com/clerk/cli/pull/196)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix `clerk skill install` failing with `No valid skills found` on published releases. The bundled skill's frontmatter now parses as strict YAML. ([#189](https://github.com/clerk/cli/pull/189)) by [@wyattjoh](https://github.com/wyattjoh)

- Hide the "install the Clerk skills" tip in `clerk --help` and bare `clerk` output when the Clerk agent skill is already installed for one of the common local agents (Claude Code, Codex, Cursor, Windsurf, Zed, Cline, VS Code, GitHub Copilot). ([#194](https://github.com/clerk/cli/pull/194)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 0.0.2

### Patch Changes

- Enrich changelog entries with PR links, commit links, and contributor handles. Generated CHANGELOG.md sections now include `(#123)` PR references and `by @user` attribution alongside each release line. ([#167](https://github.com/clerk/cli/pull/167)) by [@wyattjoh](https://github.com/wyattjoh)

- Fix biased character distribution in PKCE code verifier generation. Replaces `byte % CHARSET.length` with rejection sampling so every character in the 66-entry charset is equally likely, restoring full entropy. ([#171](https://github.com/clerk/cli/pull/171)) by [@wyattjoh](https://github.com/wyattjoh)
