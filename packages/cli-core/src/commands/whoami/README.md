# Whoami Command

Displays the email address of the currently authenticated user, plus the Clerk application this directory is linked to (if any).

## Usage

```sh
clerk whoami
clerk whoami --json
```

## Options

| Option   | Description                                                 |
| -------- | ----------------------------------------------------------- |
| `--json` | Emit a structured payload on stdout; suppresses next-steps. |

## Behavior

- Reads the stored authentication token from the local credential store.
- Fetches user info from the Clerk API and prints the user's email to **stdout**.
- Calls `resolveProfile(cwd)` (best-effort — failures are swallowed) to determine whether the working directory is linked to a Clerk application.
- When linked, prints a `Linked to ...` line on **stderr** above the next-steps, where `...` is the app label rendered by `profileLabel()` from `lib/config.ts` — for example, `Linked to MyApp (app_xxx)`.
- When not linked, only the existing `WHOAMI` next-steps are printed.
- If no token exists, throws an `AuthError` ("Not logged in").
- If the token is expired or invalid, throws an `AuthError` ("Session expired").

### `--json` (and agent mode)

When `--json` is passed, or when the CLI is in agent mode (`isAgent()`), `whoami` emits a single JSON object on stdout and skips human next-steps:

```json
{
  "email": "alice@example.com",
  "linked": {
    "appId": "app_xxx",
    "appName": "MyApp",
    "instances": { "development": "ins_dev_xxx", "production": "ins_prod_xxx" },
    "resolvedVia": "remote",
    "path": "github.com/clerk/cli"
  }
}
```

`linked` is `null` when the directory is not linked or when profile resolution fails. Optional fields (`appName`, `instances.production`) are normalized to `null` rather than omitted.

## Pipe contract

Human-mode stdout is the email and only the email — `clerk whoami | grep @` continues to work. The link line and next-steps are stderr. JSON mode replaces the email-only stdout with the full payload above.

## API Endpoints

| Method | Endpoint          | Description                                                                                                                   |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/oauth/userinfo` | Fetches the user's `email` and `sub` (user ID) using the stored access token. Base URL defaults to `https://clerk.clerk.com`. |
