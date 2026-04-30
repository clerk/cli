# switch-env

> **Internal command.** This command is intended for Clerk engineers and is not exposed to external users.

Switch the active Clerk CLI environment (e.g. `production`, `staging`).

The selected environment determines which Clerk infrastructure the CLI communicates with — OAuth endpoints, Platform API, and Backend API. Auth tokens are stored per-environment, so switching back does not require re-authentication.

## Usage

```sh
# Show current environment and available options
clerk switch-env

# Switch to staging
clerk switch-env staging

# Switch back to production
clerk switch-env production
```

## Behavior

- When called without an argument in interactive mode, shows an interactive picker listing available environments.
- When called without an argument in non-interactive mode (agent, piped stdin), prints the current environment and available options.
- Validates the environment name against the set of available profiles (injected at build time via `CLI_ENV_PROFILES`).
- Persists the selection in the CLI config file under the `environment` key.
- All subsequent commands use the selected environment's API endpoints and OAuth client.
- If no auth token exists for the target environment, prints a reminder to run `clerk auth login`.

## API endpoints

This command does not make any API calls. It only reads and writes the local config file.
