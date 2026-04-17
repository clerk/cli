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
| `--all`           | Update every clerk install found on PATH, not just the first one                  |

## Behavior

1. Fetches the latest version for the given channel from the npm registry
2. Walks `PATH` to find every `clerk` binary and picks the first one (the target the user's shell will actually execute) as the **primary target**
3. Determines which installer owns the primary target via `ownerOfBinary()`:
   - Known installer (npm/bun/pnpm/yarn) → installs via that PM
   - Homebrew → prints `brew upgrade clerk` and exits (stable channel only)
   - `null` (binary not owned by any recognized installer, e.g. `install.sh`) → refuses and lists reinstall options
4. Prompts for confirmation (skipped with `--yes` or in non-interactive mode)
5. Runs the installer's global install command (e.g. `npm install -g clerk@<version>`, `bun add -g clerk@<version>`)
6. With `--all`, repeats for every other `clerk` install on PATH, skipping Homebrew on non-stable channels and `null`-owned binaries
7. After a successful install, prints a shell-specific `hash -r` / `rehash` hint when applicable

## Why PATH-walking matters

A machine can host multiple `clerk` installs (bun + asdf-npm + Homebrew is common). `process.execPath` tells you what is running right now, but the binary the user's shell will resolve next may be a different one — e.g. `~/.bun/bin/clerk` shadowing `~/.asdf/shims/clerk`. To ensure the update actually affects the user's next `clerk` invocation, the command resolves the target from `PATH` order, not from `process.execPath`.

## Installer detection

Detection uses path-based ownership (see `lib/installer.ts`). For a given binary path:

| Check                                                 | Result                    |
| ----------------------------------------------------- | ------------------------- |
| Contains `/Cellar/clerk/`                             | `homebrew`                |
| Under `<npm prefix>/lib/node_modules`                 | `npm`                     |
| Under `<bun install dir>/install/global/node_modules` | `bun`                     |
| Under `pnpm root -g`                                  | `pnpm`                    |
| Under `<yarn global dir>/node_modules`                | `yarn`                    |
| Nothing matches                                       | `null` (refuse to update) |

When multiple PMs' dirs nest, the longest prefix wins. `null` is the signal to refuse rather than silently install via the wrong installer.

## Channels

| Channel | Tag      | Description                           |
| ------- | -------- | ------------------------------------- |
| Stable  | `latest` | Production-ready releases (default)   |
| Canary  | `canary` | Pre-release builds for early adopters |

Set `CLERK_UPDATE_CHANNEL=canary` to make canary the default for all update checks. Homebrew is updatable only on `latest` (no canary tap).

## npm registry endpoints

| Method | Path                               | Description                                             |
| ------ | ---------------------------------- | ------------------------------------------------------- |
| GET    | `https://registry.npmjs.org/clerk` | Fetch package metadata (packument) to resolve dist-tags |

## Notes

- Supports 5 installers: npm, bun, pnpm, yarn, and Homebrew.
- Binaries installed via `install.sh` (direct GitHub Release download) are owned by no PM — the update command refuses and lists reinstall options instead of silently writing to a different prefix.
- Permission errors (EACCES) suggest retrying with `sudo` using the detected installer's command.
- This command does not perform the update itself in agent/non-interactive mode unless `--yes` is passed.
