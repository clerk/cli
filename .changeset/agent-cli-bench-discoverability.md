---
"clerk": minor
---

Improve agent-CLI discoverability and add headless authentication.

- `clerk --help` now renders a top-level `Examples:` block and an `Environment:` section listing the `CLERK_*` env vars the CLI reads (`CLERK_SECRET_KEY`, `CLERK_MODE`, `CLERK_CONFIG_DIR`, `CLERK_UPDATE_CHANNEL`, `CLERK_NO_UPDATE_CHECK`).
- `clerk auth login` accepts `--token <key>` for headless authentication with a Clerk PLAPI access token. Pass `-` to read the token from stdin. The token is validated against `/oauth/userinfo`, stored without a refresh token, and surfaces a clear `AUTH_REQUIRED` error when it expires.
- `--json` option descriptions on `clerk apps list|create`, `clerk users list|create`, and `clerk doctor` now document the field shape so consumers know what to expect.
