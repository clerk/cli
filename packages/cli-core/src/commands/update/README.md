# clerk update

Updates the Clerk CLI to the latest version (or a specified release channel).

## Usage

```sh
clerk update [options]
```

## Options

| Option            | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `--channel <tag>` | Release channel to update from (default: `latest`; use `canary` for pre-releases) |
| `-y, --yes`       | Skip confirmation prompt                                                          |

## Behavior

1. Detects the installer (npm, bun, pnpm, yarn, or Homebrew) in parallel with the version check
2. Fetches the latest version for the given channel from the npm registry
3. If already up to date, exits cleanly
4. For Homebrew installations, prints `brew upgrade clerk` and exits (no auto-install)
5. Prompts for confirmation (skipped with `--yes` or in non-interactive mode)
6. Runs the detected installer's global install command (e.g. `npm install -g clerk@<version>`, `bun add -g clerk@<version>`)
7. After install, checks if a stale binary elsewhere on PATH is shadowing the installed one (e.g. a previously compiled binary in `~/.local/bin`). If found, prompts to remove it (or removes silently with `--yes`).

## Installer detection

Detection uses a multi-stage algorithm (see `lib/installer.ts`):

| Priority | Signal                                          | What it detects                                             |
| -------- | ----------------------------------------------- | ----------------------------------------------------------- |
| 1        | `npm_config_user_agent` env var                 | PM actively running the CLI (npx, bunx, pnpm dlx, yarn dlx) |
| 2        | `process.execPath` contains `/Cellar/clerk/`    | Homebrew (macOS, Linuxbrew)                                 |
| 3        | `process.execPath` matches a PM's global prefix | npm, bun, pnpm, or yarn global install                      |
| 4        | Fallback                                        | npm                                                         |

`process.execPath` is the real, symlink-resolved path to the compiled binary. For Homebrew, this resolves through the symlink into the Cellar. For npm, this is the platform binary inside `node_modules/`.

## Channels

| Channel | Tag      | Description                           |
| ------- | -------- | ------------------------------------- |
| Stable  | `latest` | Production-ready releases (default)   |
| Canary  | `canary` | Pre-release builds for early adopters |

Set `CLERK_UPDATE_CHANNEL=canary` to make canary the default for all update checks.

## npm registry endpoints

| Method | Path                               | Description                                             |
| ------ | ---------------------------------- | ------------------------------------------------------- |
| GET    | `https://registry.npmjs.org/clerk` | Fetch package metadata (packument) to resolve dist-tags |

## Notes

- Supports 5 installers: npm, bun, pnpm, yarn, and Homebrew.
- Homebrew installations are not auto-updated. The command prints `brew upgrade clerk` and exits.
- Permission errors (EACCES) suggest retrying with `sudo` using the detected installer's command.
- This command does not perform the update itself in agent/non-interactive mode unless `--yes` is passed.
- The shadowing binary check scans PATH directories. It skips shell-script shims (asdf, volta, etc.) and only flags native binaries. Skipped for Homebrew.
