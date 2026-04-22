# clerk

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
