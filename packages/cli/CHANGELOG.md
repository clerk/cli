# clerk

## 4.1.0

### Minor Changes

- Sign in from a machine without a browser: `clerk auth login` now accepts the URL your browser lands on after signing in on another device, pasted back into the terminal. ([#513](https://github.com/clerk/cli/pull/513)) by [@wyattjoh](https://github.com/wyattjoh)

- Let AI agents take a Clerk application to production. ([#550](https://github.com/clerk/cli/pull/550)) by [@shane-kercheval](https://github.com/shane-kercheval)

  - `clerk deploy --domain <domain>` in agent mode creates the production instance (or resumes the existing one) without prompting and prints the deploy report. Without `--domain` it stays read-only. In the wizard, `--domain` skips the domain prompt and `--yes` skips the confirmations.
  - `clerk deploy --domain` refuses a domain it can't apply: with an existing production instance on another domain it fails with `production_instance_exists`, and while Clerk hasn't returned the existing instance's domain yet it fails with the new `deploy_domain_unchecked`, in agent mode and the wizard alike. A wizard run whose typed domain loses a create race to another run's instance stops the same way, rather than carrying on into that instance's setup.
  - `clerk deploy` refuses more hosting providers' domains, both in `--domain` and at the wizard's domain prompt: `*.replit.app`, `*.replit.dev`, `*.onrender.com`, `*.railway.app`, `*.emergent.host`, `*.emergentagent.com`, `*.web.app`, `*.firebaseapp.com`, `*.hosted.app`, `*.workers.dev`, `*.github.io`, `*.lovable.app`, `*.bolt.host`, and `*.base44.app`, alongside `*.vercel.app` and the others it already refused. `clerk deploy` needs a domain whose DNS records you can add.
  - A 404 on the production domain's status, in `clerk deploy`, `clerk deploy status`, or the wizard's DNS polling, now fails with `deploy_instance_unresolved` instead of `not_linked` and its advice to re-link the directory. Unless the run just created the instance, the message adds that if the production instance was deleted, `clerk deploy status` reports `not_started` once Clerk stops listing it, and to run `clerk deploy --domain` then.
  - The deploy report gains `oauth.setup`: for each provider missing production credentials, the redirect URI, authorized origins, fields, and the `clerk config patch` payload and command that save them. `nextAction` now names the command to run instead of handing off to a human terminal, except for Apple's private key and, when the app uses native-only Sign in with Apple, Apple web credentials, which still go through `clerk deploy` in a terminal. OAuth secrets go into a file outside the project that the user fills in and that is removed afterward. When native-only Sign in with Apple isn't ready in production, Apple is left out of `oauth.setup` so the native fix in `nextAction` isn't buried. Once Clerk's side is complete, `nextAction` says to pipe the production keys into the host's CLI without reading them, and the new `hostSetup` field holds the command for Vercel (with `host`, `label`, `shells`, and `command`), so an agent copies it verbatim from the field instead of out of the sentence. On macOS and Linux, that command and each `oauth.setup` command start with `clerk` only when the `clerk` on PATH resolves to the running binary itself, and otherwise with the running CLI's quoted absolute path (an npm or bun global install puts npm's launcher script on PATH, so it gets the binary's path), so they work when the CLI was started with `npx`. On Windows they keep `clerk`. `hostSetup` is `[]` in every other state.
  - `clerk env pull --print` prints `KEY=value` lines to stdout instead of writing an env file, for sending production keys to a hosting provider. It fails without printing anything when Clerk returns no secret key. For an unclaimed accountless app, whose keys exist only on this machine, it prints the secret key alone, with a warning, when no publishable key is found locally.
  - `clerk config patch` and `clerk config put` print `[REDACTED]` in place of the value of any key whose name contains `secret` or `private_key` (in any case), in the diff they show before writing and in the response they print after (dry runs included). Values under other keys are printed as before. Both refuse a payload that still holds `[REDACTED]` under such a key, naming each field, so their own output can't be saved over a real secret. Error bodies logged under `--verbose` are not redacted.
  - `clerk config patch` and `clerk config put` refuse a payload that still holds an `oauth.setup` placeholder (`<client_secret>` under `client_secret`), naming each such field, and `clerk deploy status` no longer counts such a value as a saved credential.

- Add `clerk feedback` to report a wrong result, a confusing error, a missing capability or a needed improvement to Clerk. The report is scrubbed, on a best-effort basis, for common secret formats, home-directory paths and email addresses before it is sent over the telemetry channel, `--dry-run` shows exactly what would be sent, and a telemetry opt-out blocks it. ([#566](https://github.com/clerk/cli/pull/566)) by [@shane-kercheval](https://github.com/shane-kercheval)

- `clerk init --template <name>` now implies `--accountless`, so it creates a pre-configured accountless application even when you're signed in or the project is linked, instead of exiting with an error. It still errors with `--login`, `--app`, or a framework without accountless support. ([#572](https://github.com/clerk/cli/pull/572)) by [@manovotny](https://github.com/manovotny)

- `clerk doctor` checks an iOS or macOS app's Release build against the production instance: that Release's Bundle ID is registered there with Native API enabled, that its entitlements list the production Associated Domain, and that it configures Clerk with the production publishable key when the key is loaded in a way that can be read without building (otherwise it reports the key as not verified). Without a production instance this is a single note. Run in an Xcode project, `clerk deploy` and `clerk deploy status` now point to `clerk doctor` for this check. ([#548](https://github.com/clerk/cli/pull/548)) by [@seanperez29](https://github.com/seanperez29)

- Create a new iOS or macOS app with `clerk init --starter`: pick iOS (SwiftUI) or macOS (SwiftUI) on a Mac with Xcode, and init writes a SwiftUI Xcode project, then sets up Clerk, the sign-in screen, and native registration. Use `--framework ios` or `--framework macos` with `--name`, `--bundle-id`, and the new `--team-id` to skip the prompts. ([#547](https://github.com/clerk/cli/pull/547)) by [@seanperez29](https://github.com/seanperez29)

- Add `clerk migrate export auth0`, and let `clerk migrate import` read Auth0 exports, including the NDJSON file from Auth0's bulk export job. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#526](https://github.com/clerk/cli/pull/526)) by [@royanger](https://github.com/royanger)

- Add `clerk migrate export authjs`, and let `clerk migrate import` read Auth.js exports. The export reads an Auth.js database over `--db-url` (Postgres, MySQL, libsql/Turso or SQLite), finding the user table whether Prisma or Drizzle named it. Auth.js stores no passwords, so imported users sign in with OAuth or an email link, or set a password. The export reads each user's OAuth providers, so the import can offer to turn them on, and warns that Auth.js leaves OAuth users' emails unverified; `--trust-oauth-emails` marks them verified. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#529](https://github.com/clerk/cli/pull/529)) by [@royanger](https://github.com/royanger)

- Add `clerk migrate export betterauth`, and let `clerk migrate import` read Better Auth exports. The export reads a Better Auth database over `--db-url` (Postgres, MySQL, libsql/Turso or SQLite), including schemas Drizzle generated with snake_case columns or plural tables, and detects plugin columns. Better Auth's scrypt, bcrypt and argon2 passwords carry across when Clerk can verify them; any other is dropped, and that user resets it. Anonymous users are skipped. A user that a source skips, such as Supabase's soft-deleted users, no longer stops the import: it's recorded as skipped, and `--allow-partial` is only for real rejects. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#528](https://github.com/clerk/cli/pull/528)) by [@royanger](https://github.com/royanger)

- Add `clerk migrate export clerk` and `clerk migrate export supabase`, and let `clerk migrate import` take the export's run ID in place of a file and `--source`. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#524](https://github.com/clerk/cli/pull/524)) by [@royanger](https://github.com/royanger)

- Add `clerk migrate export firebase`, and let `clerk migrate import` read Firebase exports with their password hashes. The project's hash parameters come from the export, the `--firebase-*` flags, or `CLERK_FIREBASE_SIGNER_KEY`, `CLERK_FIREBASE_SALT_SEPARATOR`, `CLERK_FIREBASE_ROUNDS` and `CLERK_FIREBASE_MEM_COST`. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#525](https://github.com/clerk/cli/pull/525)) by [@royanger](https://github.com/royanger)

- Add `clerk migrate runs` and `clerk migrate undo`, and let a re-run of `clerk migrate import` continue where a stopped one left off. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#515](https://github.com/clerk/cli/pull/515)) by [@royanger](https://github.com/royanger)

  Every user an import creates now carries `clerkMigrateRun` (the run's ID) in its `private_metadata`, replacing any value the source had under that key. A re-run reads it to adopt a user whose create was cut off. Nothing removes it afterwards, and your backend can read it.

- Add `clerk migrate export workos`, and let `clerk migrate import` read WorkOS exports. WorkOS returns no password hashes, so imported users reset their password or sign in with SSO. `clerk init` now also flags a WorkOS install and links the migration guide. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`. ([#527](https://github.com/clerk/cli/pull/527)) by [@royanger](https://github.com/royanger)

- Add `clerk security`: `audit` grades an instance against Clerk's security recommendations, `fix` applies them as one config patch, and `checks` lists the catalog. Agent mode gets the report as JSON with the exact patch per finding. ([#478](https://github.com/clerk/cli/pull/478)) by [@dominic-clerk](https://github.com/dominic-clerk)

- Agents can create iOS and macOS apps end to end with JSON. `clerk init --starter --framework ios --json` (or `macos`) runs non-interactively and reports a missing name, an existing folder, a Bundle ID, or a team as an `input-required` status before anything is written. Every status after the app is written names it and the command that finishes it, and setup that stops after writing reports `setup-interrupted` instead of leaving an agent to retry `--starter`. A new app that would otherwise inherit a parent's or repository's link asks which application to use. ([#583](https://github.com/clerk/cli/pull/583)) by [@seanperez29](https://github.com/seanperez29)

### Patch Changes

- Wrap the sign-in and sign-up pages that `clerk init` creates for Next.js App Router apps in `<Suspense>`, so they no longer fail `next build` when Cache Components is enabled, as it is in new `create-next-app` projects. ([#560](https://github.com/clerk/cli/pull/560)) by [@manovotny](https://github.com/manovotny)

- In agent mode, `clerk init --app` no longer silently replaces a link to a different application. Inside a Git repository that link is shared by every project there, so relinking one folder switched them all. `clerk init` now stops, explains what would switch, and asks for `--relink`; with `--json`, it reports an `input-required` status. ([#582](https://github.com/clerk/cli/pull/582)) by [@seanperez29](https://github.com/seanperez29)

- Skip creating sign-in and sign-up pages in `clerk init` for Next.js App Router apps that already have them inside a route group, such as `app/(marketing)/sign-in/[[...sign-in]]/page.tsx`, instead of adding a second page for the same URL. ([#571](https://github.com/clerk/cli/pull/571)) by [@manovotny](https://github.com/manovotny)

- Wrap the auth header that `clerk init --starter` adds to Next.js App Router layouts in `<Suspense>`, so new apps no longer fail `next build` when Cache Components is enabled, as it is in new `create-next-app` projects. ([#567](https://github.com/clerk/cli/pull/567)) by [@manovotny](https://github.com/manovotny)

- Print plain text without terminal color codes in agent mode, so AI agents no longer see escape sequences in command output when they run without `--json`. Pass `--mode human` or set `CLERK_MODE=human` to keep colors. Status messages now also honor `NO_COLOR`. ([#534](https://github.com/clerk/cli/pull/534)) by [@royanger](https://github.com/royanger)

## 4.0.0

### Major Changes

- Connect AI clients to the Clerk MCP server by URL and remove the `clerk mcp run` stdio bridge. Re-run `clerk mcp install` to replace entries installed by earlier versions; until then they fail to connect, and `clerk mcp list` and `clerk doctor` flag them as legacy. ([#535](https://github.com/clerk/cli/pull/535)) by [@wyattjoh](https://github.com/wyattjoh)

  - Every supported client now gets a native Streamable HTTP entry in its own config format and signs in to Clerk itself, so `clerk` no longer needs to be on the editor's `PATH`. Each client's next step says how to sign in, for example `codex mcp login clerk`.
  - The server URL is saved when you install. After switching environments or changing `CLERK_MCP_URL`, re-run `clerk mcp install` to update existing entries.
  - `clerk mcp install --json` results include `migrated: true` when a legacy bridge entry was replaced, and `legacyRemaining` when one couldn't be removed. `clerk mcp list --json` entries include a `legacy` field.
  - Re-running `clerk mcp install` also clears legacy entries saved under a custom `--name`, and `clerk mcp uninstall` removes them alongside the named entry.
  - `clerk mcp install`, `list`, `uninstall`, and `clerk doctor` honor `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, and `HERMES_HOME`, so entries are read and written where each client looks for them. A symlinked config file is written through to its target, and a read-only one is left untouched.

### Minor Changes

- Show the Clerk logo, a link to the Clerk docs, and the CLI version when running `clerk auth login` in an interactive terminal. Set `CLERK_NO_BANNER=1` to hide it. ([#538](https://github.com/clerk/cli/pull/538)) by [@wyattjoh](https://github.com/wyattjoh)

- Add an experimental `clerk migrate import` that checks a Clerk or Supabase user export against your instance and imports it. It is hidden and refuses to run unless `CLERK_EXPERIMENTAL=migrate` is set. ([#520](https://github.com/clerk/cli/pull/520)) by [@royanger](https://github.com/royanger)

- Set up iOS and macOS apps with `clerk init`. Once init has linked a Clerk application, it links the Clerk Swift packages, configures capabilities, registers the native app, and optionally enables native Sign in with Apple, for both classic and JSON Xcode projects. Unchanged SwiftUI starters are initialized directly. New flags: `--dry-run` and `--json` (iOS only for now), `--xcode-project`, `--xcode-target`, `--xcode-configuration`, `--apple-sdk`, `--bundle-id`, `--app-id-prefix`, `--sign-in-with-apple`, and `--prebuilt-auth-ui`. `clerk doctor` adds read-only checks for Xcode projects. ([#512](https://github.com/clerk/cli/pull/512)) by [@seanperez29](https://github.com/seanperez29)

### Patch Changes

- Run in agent mode under OpenAI's Codex CLI, so `clerk init` creates temporary (accountless) keys instead of waiting on a browser login nobody can complete. Codex attaches a terminal to every command, which the TTY check read as a person. All commands now skip prompts and emit agent output under Codex, the same as under Claude Code; pass `--mode human` or set `CLERK_MODE=human` to override. Telemetry's `mode` field reports `agent` for Codex runs from this release. ([#522](https://github.com/clerk/cli/pull/522)) by [@shane-kercheval](https://github.com/shane-kercheval)

- Recognize native-only Sign in with Apple in `clerk deploy` and `clerk deploy status`. Apple counts as configured once its production Bundle ID registration and Native API are ready; until then deploy offers Apple web credentials or pauses with a link to the production Native Applications page. Doctor recognizes Platform API keys and verifies account access through the Clerk API when OAuth userinfo rejects a valid session. Concurrent OAuth token refreshes in one process now share a single refresh. ([#509](https://github.com/clerk/cli/pull/509)) by [@seanperez29](https://github.com/seanperez29)

- Add the internal iOS and macOS setup engine: inspect Xcode projects and workspaces, manage Clerk Swift packages and capabilities, reconcile native registration and Apple sign-in settings, and recover interrupted local edits. Support both classic and JSON Xcode project formats, unchanged SwiftUI starters, and documentation-based agent handoffs. ([#510](https://github.com/clerk/cli/pull/510)) by [@seanperez29](https://github.com/seanperez29)

## 3.4.1

### Patch Changes

- Register TanStack Start's CSRF middleware before Clerk's middleware in `src/start.ts`, both when `clerk init` creates the file and when it can safely edit an existing one. This needs `@tanstack/react-start` 1.168.10 or later; otherwise `clerk init` prints the manual steps instead. ([#523](https://github.com/clerk/cli/pull/523)) by [@SarahSoutoul](https://github.com/SarahSoutoul)

## 3.4.0

### Minor Changes

- Add fx (https://fx.sh) as a supported client for `clerk mcp install`, `list`, and `uninstall`. The Clerk MCP server is written to fx's user-global `~/.fx/mcp.json` as a direct Streamable HTTP entry (`{ "type": "http", "url": … }` under top-level `mcp`) — fx connects to the URL natively, so no `clerk mcp run` bridge is involved. Detected via the presence of `~/.fx/`; target it explicitly with `--client fx`. ([#460](https://github.com/clerk/cli/pull/460)) by [@manovotny](https://github.com/manovotny)

### Patch Changes

- Improve how API error responses are displayed: when a response contains multiple errors they are now all shown instead of just the first, and bodies that carry a plain `error` or `message` field are surfaced directly rather than as raw JSON. ([#351](https://github.com/clerk/cli/pull/351)) by [@wyattjoh](https://github.com/wyattjoh)

- Reject an invalid `clerk api` request body on your machine instead of sending it. The error echoes what arrived and, when a `-d` value reached the CLI with its double quotes stripped or wrapped in literal single quotes, names the shell quoting behind it — an unquoted body in a POSIX shell, or PowerShell before 7.3 and cmd.exe on Windows — and suggests the same request with `--file`, which no shell can mangle. Those shell-quoting rejections carry the error code `invalid_json_shell_quoting`; other parse failures keep `invalid_json`. ([#464](https://github.com/clerk/cli/pull/464)) by [@dmoerner](https://github.com/dmoerner)

- Replace the Clerk Skills install box on the sign-in success page with three command cards — install, customize, and deploy — showing what the CLI can do right after authentication. ([#473](https://github.com/clerk/cli/pull/473)) by [@eatmorespinach](https://github.com/eatmorespinach)

- Simplify the sign-in success page so the command cards sit directly beneath the confirmation, and keep the page readable on short screens. ([#494](https://github.com/clerk/cli/pull/494)) by [@maxyinger](https://github.com/maxyinger)

- Restyle the sign-in success page with a theme-aware Clerk mark, the command cards grouped into a banner along the bottom, and a staggered entrance animation. ([#473](https://github.com/clerk/cli/pull/473)) by [@eatmorespinach](https://github.com/eatmorespinach)

- `clerk auth login` now explains why a keyless application could not be claimed when the active workspace is managed by an integration such as Vercel Marketplace or Stripe. When the Platform API rejects the claim with the error code `accountless_application_managed_workspace`, the CLI prints the API message, for example "Unable to claim - The target application cannot be claimed into the current workspace. Select a different workspace and try again.", instead of the generic "no active organization" warning, and keeps the local claim token so the next `clerk auth login` from a workspace you own claims the application. ([#471](https://github.com/clerk/cli/pull/471)) by [@Zertsov](https://github.com/Zertsov)

- Fix `clerk deploy` not listing which features your plan doesn't cover when the Platform API rejects the deploy for an insufficient subscription plan. ([#477](https://github.com/clerk/cli/pull/477)) by [@djgould](https://github.com/djgould)

- `clerk deploy` copy fixes: ([#484](https://github.com/clerk/cli/pull/484)) by [@shane-kercheval](https://github.com/shane-kercheval)

  - `clerk deploy --help` describes what the bare command does and the JSON report it prints under an agent.
  - The preamble says a hosting provider's generated URL can't be the production domain.
  - The confirmation screen lists all five DNS record hosts, including DKIM, and says DNS records will be needed for them once the instance exists.
  - The DNS check reports records as "not found yet" with a minutes-not-days expectation, tells you what to do based on what's actually pending, and links the Dashboard Domains page for changing the domain.
  - `clerk auth login` prints the claimed app's Dashboard URL; the wizard prints the new production instance's URL and its next steps say the pulled keys go on the host alongside the other Clerk variables.
  - The Google walkthrough adds a tip explaining that the OAuth consent screen's app name is what users see when they sign in, and to choose the name they should see.
  - The DNS check footer points at the "Check again" prompt that follows it instead of telling you to quit and re-run; the closing screen no longer says "Production ready", "sign up at your domain", or "Success" when DNS verification was skipped.
  - Resuming the wizard shows only the DNS records still outstanding, not ones Clerk already verified. When none are outstanding, the DNS screen says what is (the SSL certificate, Clerk finalizing, or a record list Clerk didn't return) instead of a "Configure DNS" page with no records, and the closing screen says "Not yet verified" rather than "DNS pending" so it is right when DNS is done and something else is pending.
  - Each DNS record host is named the same way on every screen, the note about what Clerk manages moved off the rows the user has to add, the Domains-page pointer carries its link, and the closing line says what happens next instead of implying that skipping the check finishes the deploy, and no longer promises an OAuth step on resume when OAuth has already run.
  - Agent-mode `nextAction` tells the agent to add pending DNS records instead of polling, at `complete` says the production keys still have to reach the host, and names OAuth providers the CLI could not configure so an agent doesn't report OAuth as done. Human-mode `clerk deploy status` prints the pending records, never says "ask the user", and resumes with `clerk deploy` rather than a flag that only affects agents.
  - The wizard's new sentences wrap at 76 columns so they stay inside the gutter on an 80-column terminal. The agent JSON report gains a `urls` field with the production instance's Dashboard page and its Domains page. Human-mode `deploy status` now renders its sentence from the same classification of the report as `nextAction` rather than by rewriting that sentence; both read the same as before this change.

- Record `clerk deploy status` on an unfinished deploy as incomplete rather than an error in usage telemetry, and give the ways a `clerk deploy` run can end their own error codes — a skipped step, an interrupted prompt and a wait on Clerk's provisioning were previously indistinguishable. Every `clerk deploy` and `clerk deploy status` event now also records the state the deploy was in when the run ended, so a run that stopped short says where, and which of DNS, SSL, email DNS and OAuth had been verified at that point — recorded only from a read that actually succeeded, so a failed status call is never reported as a failed check. Output and exit codes are unchanged. ([#492](https://github.com/clerk/cli/pull/492)) by [@shane-kercheval](https://github.com/shane-kercheval)

  `clerk doctor` now names the check that crashed instead of printing an anonymous "Check crashed" line (which `--json` labelled "Unknown check"), says the crash is a bug in the CLI instead of reporting issues with your integration, and reports a crashed check as `doctor_check_crashed` rather than `doctor_failed`, so a bug in the CLI is distinguishable from a real problem with your integration. Its `--json` results carry `crashed: true` on that check. The exit code is unchanged.

  `clerk api`, `clerk users create` and `clerk mcp install --json` failures now carry an error code in usage telemetry — each prints the failure itself instead of throwing, which used to leave the event with a bare error. An API response with a Clerk error code records that code; one without is recorded by its HTTP status as `api_rate_limited` (429), `api_not_found` (a 404 on a path the person typed), `cli_endpoint_not_found` (a 404 on a path the CLI built, from its endpoint catalog or a hardcoded route), `api_client_error` (other 4xx) or `api_error` (5xx). `mcp install --json` records the same code human mode already did. Nothing printed changes and exit codes are unchanged.

- Describe the `clerk` npm package so that people and coding agents who search npm find it before its per-platform binary packages. The package description now says what the CLI does and how to start (`npx -y clerk@latest init`), the keywords cover the frameworks and agent use cases it serves, and each `@clerk/cli-*` platform package now says to install `clerk` instead. ([#502](https://github.com/clerk/cli/pull/502)) by [@Zertsov](https://github.com/Zertsov)

## 3.3.0

### Minor Changes

- Add `clerk init --accountless` as the canonical flag and keep `--keyless` as a deprecated compatibility alias. `open` and `whoami` agent JSON now emit the canonical `accountless` key alongside the deprecated `keyless` alias. ([#457](https://github.com/clerk/cli/pull/457)) by [@SarahSoutoul](https://github.com/SarahSoutoul)

### Patch Changes

- List commands and options alphabetically in `--help` output so they are easier to scan. ([#462](https://github.com/clerk/cli/pull/462)) by [@manovotny](https://github.com/manovotny)

## 3.2.0

### Minor Changes

- Give every failure a specific error code, and record which step a multi-step command reached. ([#441](https://github.com/clerk/cli/pull/441)) by [@djgould](https://github.com/djgould)

  Agent-mode JSON now carries a code for failures that previously reported only a message, and `clerk init` reports the step it stopped at rather than a single generic failure.

### Patch Changes

- Make the `clerk api` endpoint catalog discoverable from help output and 404 responses. ([#430](https://github.com/clerk/cli/pull/430)) by [@shane-kercheval](https://github.com/shane-kercheval)

  - Root help now describes `api` as "Call any Clerk API endpoint (200+; `clerk api ls` to browse)" instead of "Make authenticated requests to the Clerk API", and `clerk api --help` explains that this command covers what the dedicated commands do not.
  - `--platform` now explains that the Platform API has its own endpoint list, `clerk api ls` examples say which API they list (they cover the Backend API, not every endpoint), and `clerk api ls --platform` is shown as an example.
  - A 404 with no parsed Clerk error code now suggests `clerk api ls <keyword>` on stderr, leaving stdout as the pipeable response body. The suggestion is scoped per surface: `--platform` appends that flag, and `--fapi` gets none since it has no endpoint catalog.

- Report why `clerk auth login` failed instead of collapsing every failure into one error. ([#442](https://github.com/clerk/cli/pull/442)) by [@djgould](https://github.com/djgould)

  The browser sign-in wait, OAuth provider errors, state mismatches, missing authorization codes, and callback bind failures now carry distinct error codes, and login records which step of the flow it reached.

- Increase the `clerk login` browser authentication timeout from 2 to 15 minutes, so sign-up flows with email verification don't time out. ([#443](https://github.com/clerk/cli/pull/443)) by [@djgould](https://github.com/djgould)

- Report what was established when Ctrl-C interrupts `clerk deploy status`, and record interrupted runs in usage telemetry. ([#425](https://github.com/clerk/cli/pull/425)) by [@wyattjoh](https://github.com/wyattjoh)

  - `clerk deploy status` no longer exits silently when the interrupt arrives before the deploy state is read. Agent mode emits a report with `state: "interrupted"`, which asserts nothing about the deploy.
  - An interrupted command now sends its `abort` outcome instead of no event at all.

- Report when signing out cannot revoke the session with Clerk, instead of always printing a clean sign-out. Local credentials are still removed either way, and `clerk auth logout` now also warns when `CLERK_PLATFORM_API_KEY` is set, since that key keeps authenticating requests. ([#422](https://github.com/clerk/cli/pull/422)) by [@wyattjoh](https://github.com/wyattjoh)

  Revoke the superseded session more reliably when re-authenticating: a transient error while checking the existing session no longer leaves the old session un-revoked, and a malformed `CLERK_OAUTH_BASE_URL` no longer aborts sign-out partway through.

- Revoke the OAuth session with Clerk when signing out, so `clerk auth logout` ends the session everywhere instead of only deleting the local credentials. Re-authenticating over an existing session now revokes the previous one as well. ([#418](https://github.com/clerk/cli/pull/418)) by [@wyattjoh](https://github.com/wyattjoh)

- Stop a failing interrupt sequence from printing an unhandled rejection on Ctrl-C. ([#436](https://github.com/clerk/cli/pull/436)) by [@wyattjoh](https://github.com/wyattjoh)

  The SIGINT handler is async so it can await the telemetry flush that reports the interrupted run, but it was registered directly with `process.on`, which discards a listener's return value. If anything in that sequence rejected — the lazy telemetry import, the flush itself — the failure surfaced as an unhandled rejection stack trace at the exact moment the user was trying to get their shell back, and the process never reached the signal death that a wrapping script reads. The registered listener is now a synchronous wrapper that exits by the route the interrupt calls for even when the sequence fails.

- Stop sending telemetry for `clerk completion`. Shells re-run it on every startup when it is wired into an rc file, so its events measured shell startups rather than CLI usage. ([#417](https://github.com/clerk/cli/pull/417)) by [@djgould](https://github.com/djgould)

- Fix the exit code when a command is interrupted with Ctrl-C. Interrupting a command now exits 130 by terminating on SIGINT rather than calling `process.exit(130)`, so a wrapping shell script sees a real signal death and stops as expected, and the interrupted run is reported to telemetry instead of going unrecorded. This covers in-flight requests, poll intervals and retry backoffs, project generators run by `clerk init`, and `clerk webhooks listen` once it has drained. Ctrl-C while the CLI is only waiting on you — at a prompt, during browser sign-in, or in `$EDITOR` — still exits 0. ([#420](https://github.com/clerk/cli/pull/420)) by [@wyattjoh](https://github.com/wyattjoh)

- Keep `--define CLI_VERSION` working when building with Bun 1.4. ([#435](https://github.com/clerk/cli/pull/435)) by [@rafa-thayto](https://github.com/rafa-thayto)

  Bun 1.4 runs macros in a sealed transpiler context that `--define` globals no longer reach, so the version macro silently fell back to the checkout-derived dev version even when a release version was injected. The define check and dev classification now live in `version.ts` module scope, where define substitution still applies; the macro only derives the Git checkout fallback.

- Stop the "Update available" notice from garbling the "Next steps" block. ([#435](https://github.com/clerk/cli/pull/435)) by [@rafa-thayto](https://github.com/rafa-thayto)

  The next-steps outro animation moves the cursor back onto the header line for ~450ms, but several commands (`switch-env`, `auth logout`, `unlink`, `users create`, `apps create`, and others) did not await it. The command's promise resolved mid-animation, so the post-command update check printed its notice at the parked cursor position — overwriting the step lines and leaving a stray duplicate "Next steps" header. Every `outro(...)` call is now awaited, so output printed after a command lands below the finished block.

## 3.1.0

### Minor Changes

- Collect usage telemetry (command name, flag names, duration, outcome, a random machine identifier — and your workspace and app IDs when a project is linked; never arguments, option values, paths, or personal data). The first run only shows a disclosure notice and sends nothing (CI environments send from the first run), and `--verbose` prints every event before it is sent. Control it with the new `clerk telemetry status|disable|enable` subcommand, or the `CLERK_TELEMETRY_DISABLED` / `DO_NOT_TRACK` environment variables (any non-false value opts out). ([#410](https://github.com/clerk/cli/pull/410)) by [@djgould](https://github.com/djgould)

## 3.0.1

### Patch Changes

- Fix `clerk auth login` in WSL2, SSH, and headless environments: the sign-in URL is now always printed as a copy-friendly manual fallback, WSL launches the Windows host browser via PowerShell interop when `wslview` is not installed, and the authentication timeout error now explains how to recover. ([#412](https://github.com/clerk/cli/pull/412)) by [@rafa-thayto](https://github.com/rafa-thayto)

## 3.0.0

### Major Changes

- Make keyless mode the default for unauthenticated `clerk init` runs on keyless-capable frameworks, and let an unclaimed keyless application be configured end to end without an account. ([#395](https://github.com/clerk/cli/pull/395)) by [@rafa-thayto](https://github.com/rafa-thayto)

  - `clerk init` while signed out now bootstraps with auto-generated development keys instead of forcing a browser login; running `clerk auth login` later claims the application. `--keyless` forces keyless mode even when signed in, `--login` forces the authenticated flow, and `--template <b2b-saas|b2c-saas|native|waitlist>` shapes the application at creation. Re-running init keeps an existing unclaimed application — whether `clerk init` or a Clerk SDK minted it — unless `--fresh` explicitly asks for a replacement.
  - `clerk config pull` and `clerk config patch` work on an unclaimed application through the Backend API, addressing its resources directly: `instance`, `communication`, `restrictions`, `organization_settings`, `protect`, `oauth_application_settings`, and `instance_settings`. Unsupported groups and unrecognized `instance` fields exit with a usage error naming what the API accepts, instead of printing success while the write was silently dropped; applied writes are verified against the API's own response.
  - `clerk enable orgs`/`disable orgs`, `clerk whoami`, `clerk env pull`, `clerk doctor`, `clerk open`, `clerk users`, and `clerk api` all operate on an unclaimed keyless application, resolving the project's own secret key from its env files or the SDK's `.clerk/.tmp/keyless.json`. An exported `CLERK_SECRET_KEY` keeps its existing precedence, including over a linked profile. Commands that genuinely need a claimed application (billing, `config put`, `config schema`, `users open`) say so and name the reason instead of failing with "not linked".
  - `clerk whoami` and `clerk env pull` detect a publishable/secret key pair belonging to two different applications — `whoami` warns, `env pull` refuses to write the pair. `whoami` in an unlinked directory also points out a local secret key when one is present, since `clerk api` and `clerk users` will use that key's instance rather than the signed-in account.

### Minor Changes

- Close the `clerk init` framework scaffolding gaps. ([#394](https://github.com/clerk/cli/pull/394)) by [@rafa-thayto](https://github.com/rafa-thayto)

  - Expo projects get their expo-router root layout wrapped with `<ClerkProvider>` and the secure token cache, and `clerk init --starter --framework expo` bootstraps a new Expo app.
  - Express and Fastify projects get `clerkMiddleware()` / `clerkPlugin` wired into the server entry file (ESM and CommonJS), plus the request type augmentation for TypeScript Express apps.
  - iOS (Swift) and Android (Kotlin) projects are now detected (via Xcode project bundles and AndroidManifest.xml) and `clerk init --framework ios|android` is accepted; init links the app, pulls API keys, and prints the exact SDK setup steps.

### Patch Changes

- Make `clerk users create` confirm before writing. The command registers `--yes` as "Skip confirmation prompt" and its examples recommend passing it, but no prompt existed, so the flag did nothing and the user was created immediately. Human mode now previews the redacted request body and asks before the POST. Agent mode is unchanged: it never prompts, so `--dry-run` remains the safety net there. ([#400](https://github.com/clerk/cli/pull/400)) by [@manovotny](https://github.com/manovotny)

## 2.3.1

### Patch Changes

- Show the "+ Create a new application" option first in the interactive application picker used by `clerk link` and `clerk users`. ([#401](https://github.com/clerk/cli/pull/401)) by [@rafa-thayto](https://github.com/rafa-thayto)

- Fix `clerk enable orgs --auto-create` so organizations are actually auto-created for new users. The flag now also enables organization creation defaults, which the API requires before honoring the automatic creation setting. ([#390](https://github.com/clerk/cli/pull/390)) by [@manovotny](https://github.com/manovotny)

## 2.3.0

### Minor Changes

- Add `clerk mcp install`, `list`, `uninstall`, and `run` to connect the Clerk remote MCP server (`https://mcp.clerk.com/mcp`) to Claude Code, Cursor, GitHub Copilot (VS Code; `--client vscode` or `--client copilot`), Windsurf, Gemini, Codex, opencode, OpenClaw, Warp, and Hermes Agent. Clients that ship a non-interactive MCP registration CLI are registered by shelling out to it — `claude mcp add`, `gemini mcp add`, `codex mcp add`, `code --add-mcp`, `openclaw mcp add --no-probe`, `hermes mcp add` — so each client owns its config format and write safety; for those, the client's binary must be on PATH (detection is PATH-based, no file-write fallback). Cursor, Windsurf, Warp (no CLI), and opencode (interactive-only CLI) get their user-global config file written directly, and VS Code removal (add-only CLI) edits its `mcp.json` in place. `clerk mcp list --json` reports `{ entries, failures }` so an unreadable client config surfaces structurally instead of reading as "nothing installed". Install always converges: an existing entry under the same name is replaced. Each client is configured to launch `clerk mcp run` — a built-in stdio bridge that forwards the editor's stdio JSON-RPC to the remote server over HTTP (the job `npx mcp-remote` did, now with no npx dependency), so `clerk` must be on your PATH. `clerk doctor` gains an MCP reachability check that probes each configured server via the MCP `initialize` handshake when an entry is installed. The URL resolves in order: the `CLERK_MCP_URL` override (for local worker development) > the active env profile's `mcpUrl` field > the hosted server, so `clerk mcp install` works with no flags. The bridge is transport-only for now; against an auth-required server it surfaces a clear error rather than signing in. ([#307](https://github.com/clerk/cli/pull/307)) by [@rafa-thayto](https://github.com/rafa-thayto)

### Patch Changes

- Stop scaffolding deprecated `createRouteMatcher` route protection in Next.js middleware during `clerk init` — generate bare `clerkMiddleware()` and point to resource-level protection with `auth.protect()` instead. ([#387](https://github.com/clerk/cli/pull/387)) by [@rafa-thayto](https://github.com/rafa-thayto)

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
