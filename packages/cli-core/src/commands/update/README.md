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

1. Detects the package runner from `npm_config_user_agent` (npm, bun, pnpm, or yarn; defaults to npm)
2. Fetches the latest version for the given channel from the npm registry
3. If already up to date, exits cleanly
4. Prompts for confirmation (skipped with `--yes` or in non-interactive mode)
5. Runs the detected runner's global install command (e.g. `npm install -g clerk@<version>`, `bun add -g clerk@<version>`)
6. After install, checks if a stale binary elsewhere on PATH is shadowing the runner-installed one (e.g. a previously compiled binary in `~/.local/bin`). If found, prompts to remove it (or removes silently with `--yes`).

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

- Detects the package runner from `npm_config_user_agent` (set when invoked through a package manager). Supports npm, bun, pnpm, and yarn. Falls back to npm for direct binary invocation.
- Permission errors (EACCES) suggest retrying with `sudo` using the detected runner's install command.
- This command does not perform the update itself in agent/non-interactive mode unless `--yes` is passed.
- The shadowing binary check scans PATH directories. It skips shell-script shims (asdf, volta, etc.) and only flags native binaries.
