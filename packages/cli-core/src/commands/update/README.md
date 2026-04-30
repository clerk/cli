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
2. Walks `PATH` to find every `clerk` binary. For asdf shims (bash scripts, not symlinks), resolves through `asdf which <name>` so the underlying installer is visible. The **primary target** is the install that owns `process.execPath` (the binary the user just invoked). If the running binary can't be matched against any enumerated install, falls back to the first PATH entry.
3. Determines which installer owns the primary target via `ownerOfBinary()`:
   - Known installer (npm/bun/pnpm/yarn) → installs via that PM
   - Homebrew → runs `brew upgrade clerk` after confirmation (stable channel only; refuses on `canary` since there is no canary tap). After the brew command succeeds, verifies the installed version matches the npm registry's `latest`; fails loudly if the tap is stale.
   - `null` (binary not owned by any recognized installer, e.g. `install.sh`) → refuses and lists reinstall options
4. Prompts for confirmation (skipped with `--yes` or in non-interactive mode)
5. Runs the installer's global install command (e.g. `npm install -g clerk@<version>`, `bun add -g clerk@<version>`)
6. If any updated target was inside an asdf-managed tool, runs `asdf reshim <plugin>` so the shim picks up the new binary (safety net; modern asdf-nodejs auto-reshims)
7. With `--all`, updates every on-PATH `clerk` install whose owner the CLI can drive. If the primary itself is blocked (e.g. Homebrew on `canary`, or `null` owner), the primary is skipped with a warning and the remaining installs still run; the run only refuses when every target is blocked. Failures on individual installs are recorded in the summary but don't short-circuit the rest.
8. After a successful install, prints a shell-specific `hash -r` / `rehash` hint when applicable

## Primary target selection

A machine can host multiple `clerk` installs (bun + asdf-npm + Homebrew is common). The command walks `PATH` to enumerate every install, then picks the one that owns `process.execPath` as the primary. This is the binary the user just invoked — updating any other install would leave `clerk -v` unchanged and silently diverge what the user sees from what the command reported as "updated".

PATH order alone is insufficient because a fresh `PATH` walk can disagree with what actually ran: zsh and bash cache resolved command paths in a hash table, and `PATH` ordering under asdf + bun can place the asdf shim before `~/.bun/bin` even though the user's shell hash still points at bun's install. The running install is authoritative in every case.

Remaining installs are reported as "others" and updated only with `--all`. If the running binary can't be classified (standalone `install.sh` binary, or `process.execPath` outside any known installer dir), the command falls back to PATH-first order.

## Version managers (asdf, nvm)

- **nvm**: fully supported without special handling. nvm uses real symlinks, so `realpath` chases them into `<nvm-version>/lib/node_modules/clerk/bin/clerk`, which matches the active `npm root -g`; `ownerOfBinary` returns `"npm"`.
- **asdf**: handled via `resolveAsdfShim()`. asdf shims (`~/.asdf/shims/<name>`) are bash scripts, not symlinks, so `realpath` returns the shim itself. The update command calls `asdf which <name>` to find the underlying binary (e.g. `~/.asdf/installs/nodejs/22.16.0/bin/clerk`), realpaths it into the asdf-managed node's `lib/node_modules`, and treats it as `"npm"` with a post-install `asdf reshim <plugin>`. Honors `$ASDF_DATA_DIR` when set. If `asdf` isn't on PATH the shim path is returned unchanged and ownership falls back to `null`.

## Installer detection

Detection uses path-based ownership (see `lib/installer.ts`). For a given binary path:

| Check                                                                                          | Result                    |
| ---------------------------------------------------------------------------------------------- | ------------------------- |
| Contains `/Cellar/clerk/`                                                                      | `homebrew`                |
| Under `npm root -g` (`<prefix>/lib/node_modules` on POSIX, `<prefix>\node_modules` on Windows) | `npm`                     |
| Under `<bun install dir>/install/global/node_modules`                                          | `bun`                     |
| Under `pnpm root -g`                                                                           | `pnpm`                    |
| Under `<yarn global dir>/node_modules`                                                         | `yarn`                    |
| Nothing matches                                                                                | `null` (refuse to update) |

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
- Binaries installed via `install.sh` (direct GitHub Release download) are owned by no PM; the update command refuses and lists reinstall options instead of silently writing to a different prefix.
- Permission errors (EACCES) suggest retrying with `sudo` using the detected installer's command.
- This command does not perform the update itself in agent/non-interactive mode unless `--yes` is passed. In agent mode without `--yes`, it prints the command the caller needs to run and exits.
