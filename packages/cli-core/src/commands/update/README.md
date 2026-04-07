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

1. Fetches the latest version for the given channel from the npm registry
2. If already up to date, exits cleanly
3. Prompts for confirmation (skipped with `--yes` or in non-interactive mode)
4. Runs `npm install -g clerk@<version>` to install

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

- Requires `npm` on PATH. If not found, the command will print instructions.
- Permission errors (EACCES) suggest trying `sudo npm install -g clerk@<version>` or using a Node version manager like nvm.
- This command does not perform the update itself in agent/non-interactive mode unless `--yes` is passed.
