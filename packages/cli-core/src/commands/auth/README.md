# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login` (aliases: `signup`, `signin`, `sign-in`)

Authenticates the user via an OAuth 2.0 PKCE flow. After a successful login (or when an existing session is detected in agent mode), the command attempts to automatically claim any keyless application previously created by `clerk init`.

1. Checks for an existing valid token — if found, prompts to re-authenticate (in agent mode, skips and runs autoclaim immediately)
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Opens the browser to the Clerk OAuth authorization URL
5. Waits for the redirect callback with an authorization code
6. Exchanges the code for an access token
7. Stores the token and user info in local config
8. **Autoclaim**: if `.clerk/keyless.json` exists in the current directory, claims the temporary application, links it to the project, and pulls environment variables

#### Headless authentication (`--token`)

For CI and AI agents, pass a Clerk PLAPI access token directly with `--token <key>`:

- `clerk auth login --token sk_test_…` — token as an inline argument
- `clerk auth login --token -` — read the token from stdin (e.g. piped from a secret store)
- `clerk auth login --token "$CLERK_OAUTH_TOKEN"` — from an env var

The flow short-circuits OAuth: the token is validated against `/oauth/userinfo`, then stored in the credential store with no refresh token. When the token expires, the next API call surfaces a clear `AUTH_REQUIRED` error and the user must re-run login with a fresh token.

For per-instance API access (e.g. `clerk api`, `clerk users`, `clerk config`), `CLERK_SECRET_KEY=sk_…` in the environment works directly — no login needed.

#### Keyless autoclaim breadcrumb lifecycle

When `clerk init` runs in keyless mode it writes `.clerk/keyless.json` containing a claim token. On the next `clerk auth login`:

- **404** — claim token expired or application already deleted; breadcrumb is cleared and a warning is shown.
- **403** — authenticated account has no active organization; breadcrumb is cleared and a warning is shown.
- **Any other error** — treated as transient; breadcrumb is preserved so the next login retries.
- **Success** — application is claimed and linked, `.env` is updated via `clerk env pull`, breadcrumb is deleted.

#### API Endpoints

OAuth requests are made against the Clerk OAuth system instance (default `https://clerk.clerk.com`, overridable via `CLERK_OAUTH_BASE_URL`). Autoclaim requests are made against the Platform API (default `https://api.clerk.com`, overridable via `CLERK_PLATFORM_API_URL`).

| Step           | Method | Endpoint                                      | Description                                                                       |
| -------------- | ------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Authorize      | `GET`  | `/oauth/authorize`                            | Browser redirect with PKCE `code_challenge`, `state`, `client_id`, `redirect_uri` |
| Token exchange | `POST` | `/oauth/token`                                | Exchanges authorization code + `code_verifier` for an access token                |
| User info      | `GET`  | `/oauth/userinfo`                             | Fetches `sub` (user ID) and `email` using the access token                        |
| Autoclaim      | `POST` | `/v1/platform/accountless_applications/claim` | Claims a keyless application by token; returns the full `Application` object      |

### `clerk auth logout` (aliases: `signout`, `sign-out`)

Removes the stored authentication token and clears auth info from local config. No API calls are made.
