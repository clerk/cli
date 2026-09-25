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
- If no token exists, falls back to the accountless path below; when that finds nothing either, throws an `AuthError` ("Not logged in").

### Accountless applications

An unclaimed accountless application has no account to name, so the instance itself is the identity. When there's no stored token but the directory holds an instance secret key (env var, `.env`/`.env.local`, or `.clerk/.tmp/keyless.json` — see [`lib/keyless-target.ts`](../../lib/keyless-target.ts)), `whoami` reads `GET /v1/instance` with that key and reports the instance instead of erroring. A secret key the API rejects (revoked, malformed) surfaces as an error naming the key and where it came from, not a bare "Request failed (401)".

```json
{
  "email": null,
  "accountless": {
    "instanceId": "ins_...",
    "environmentType": "development",
    "publishableKey": "pk_test_...",
    "publishableKeyMismatch": false,
    "keySource": ".clerk/.tmp/keyless.json"
  },
  "keyless": { "…": "deprecated alias — same object as `accountless`" },
  "linked": null
}
```

`keyless` is a deprecated alias of `accountless`, carrying the identical object, kept for agents that still parse the legacy key.

`publishableKey` and the secret key are found independently (see `findLocalSecretKey`/`findLocalPublishableKey` in `lib/keyless-target.ts`) and can each belong to a _different_ accountless application if a project's env files hold leftovers from more than one. `publishableKeyMismatch` is `true` when that's happened — checked by decoding the publishable key's Frontend API host (`decodePublishableKey` in `lib/fapi.ts`) and confirming it appears in the secret key's own `GET /v1/domains`. Whoami only warns in this case (on **stderr**) and still reports what it found; `clerk env pull` is the stricter, refusing to write the mismatched pair (see [`commands/env/README.md`](../env/README.md)).

In human mode the instance ID goes to **stdout** and the explanation (including where the key came from) to **stderr**.

| Method | Endpoint       | Description                                                                                    |
| ------ | -------------- | ---------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/instance` | Reads the accountless instance's identity. Authenticated with the secret key.                  |
| `GET`  | `/v1/domains`  | Only when a local publishable key was found — checks it against the secret key's own instance. |

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
