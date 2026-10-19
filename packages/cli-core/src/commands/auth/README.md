# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login` (aliases: `signup`, `signin`, `sign-in`)

Authenticates the user via an OAuth 2.0 PKCE flow. After a successful login (or when an existing session is detected in agent mode), the command attempts to automatically claim any accountless application previously created by `clerk init`.

Before signing in, the command prints a banner: the Clerk logo beside a link to the Clerk docs and the CLI version, plus the active environment (e.g. `staging`) when it isn't production. It's drawn by `lib/banner.ts`, and only from this command's action, so `init`, `link`, and `doctor`, which call `login()` mid-flow, don't print it. The banner is skipped in agent mode, when stderr isn't a terminal, in CI, and when `CLERK_NO_BANNER` is set. `NO_COLOR` prints it without color.

1. Checks for an existing valid token — if found, prompts to re-authenticate (in agent mode, skips and runs autoclaim immediately)
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Prints the Clerk OAuth authorization URL and opens the browser to it. The URL is always printed as a manual fallback for environments where browser launch is unreliable (WSL2, SSH, headless shells). In WSL, the Windows host browser is reached via `wslview` or, when that is not installed, the always-present `powershell.exe` interop binary (`Start-Process`).
5. Waits for the authorization code. In an interactive terminal (human mode with a TTY stdin), it also shows a paste prompt alongside the loopback wait, and whichever delivers a code first wins. The prompt is for machines without a browser: sign in on another device, where the redirect to `127.0.0.1` fails to load, then paste that URL from the address bar. Only the full redirect URL is accepted. It passes the same checks as the loopback redirect, including `state`, so a code from someone else's sign-in is refused. The code is useless without the PKCE verifier, which never leaves the process. Agents, pipes, and CI wait on the loopback only
6. Exchanges the code for an access token
7. Stores the token and user info in local config
8. If this was a re-authentication over an existing session, revokes the previous grant. The outgoing session is read once the authorization code arrives and just before the token exchange replaces it, and revoked only after the replacement is stored — so an abandoned browser flow leaves the original session intact, and a concurrent refresh has the smallest possible window to rotate the token out from under the revocation. A failure here warns rather than failing the login
9. **Autoclaim**: if `.clerk/keyless.json` exists in the current directory, claims the temporary application. It then links it to the project and pulls environment variables only when the folder's keys belong to that application, or the folder has no Clerk keys (see below)

#### Accountless autoclaim breadcrumb lifecycle

When `clerk init` runs in accountless mode it writes `.clerk/keyless.json` containing a claim token. On the next `clerk auth login`:

- **404** — claim token expired or application already deleted; breadcrumb is cleared and a warning is shown.
- **403** — authenticated account has no active organization; breadcrumb is cleared and a warning is shown.
- **Any other error** — treated as transient; breadcrumb is preserved so the next login retries.
- **Success** — application is claimed and the breadcrumb is deleted. The command prints the Dashboard URL of the claimed app's development instance, since this is the first time the app has a home in an account. What happens to the folder depends on what it already holds:
  - **No Clerk keys, or only keys that belong to the claimed app** — the folder is linked to it and its keys are written via `clerk env pull`, into the same folder.
  - **Linked to a different app** — the link and env files are left alone. The warning names the linked app and the command to switch: `clerk link --app <claimed app id>`.
  - **A key that isn't the claimed app's** — the link and env files are left alone. The warning names the key's kind and where it came from (never its value) and only what the CLI established:
    - a publishable key: run `clerk link`, which looks in your account for the app that key belongs to;
    - only secret keys: find the app's ID with `clerk apps list --json`, then run `clerk link --app <app_id>`;
    - keys from the claimed app and another app: make the folder's keys belong to one app, then run `clerk link`.
  - **Can't tell** (a key that can't be decoded, an env file that can't be read, an error looking up the folder's link, an SDK keyless file that can't be read or holds no key, or an app whose keys can't be fetched) — the link and env files are left alone. The warning offers `clerk apps list --json` with `clerk link --app <app_id>`, or `clerk link --app <claimed app id>`.
  - **Linking fails** — printed after the claim line, with the reason.

  Every Clerk key the folder holds is compared, not just the one its app loads: keys in the shell and in `.env`, `.env.development`, `.env.local`, and `.env.development.local`, under the framework's variable names and the generic ones. `clerk env pull` picks its own file to write (`.env.development.local` first), so a key left uncompared could be the one it replaces. The SDK's `.clerk/.tmp/keyless.json` counts only when there's no plain key of either kind. A publishable key matches when it is one of the claimed app's keys or decodes to the same Frontend API host; a secret key matches only when it is identical, and is compared in memory, never logged. The check runs after the claim because the breadcrumb holds only a token, with no app identity; a mismatched app still lands in the account, which is harmless. When the claim response lacks the app's instances or the keys to compare, the app is fetched once (`GET /v1/platform/applications/{id}`) and that copy is used throughout. The warnings name the next command themselves, because agents never see the closing next steps.

#### API Endpoints

OAuth requests are made against the Clerk OAuth system instance (default `https://clerk.clerk.com`, overridable via `CLERK_OAUTH_BASE_URL`). Autoclaim requests are made against the Platform API (default `https://api.clerk.com`, overridable via `CLERK_PLATFORM_API_URL`).

| Step           | Method | Endpoint                                      | Description                                                                       |
| -------------- | ------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Authorize      | `GET`  | `/oauth/authorize`                            | Browser redirect with PKCE `code_challenge`, `state`, `client_id`, `redirect_uri` |
| Token exchange | `POST` | `/oauth/token`                                | Exchanges authorization code + `code_verifier` for an access token                |
| User info      | `GET`  | `/oauth/userinfo`                             | Fetches `sub` (user ID) and `email` using the access token                        |
| Revoke         | `POST` | `/oauth/token/revoke`                         | Revokes the superseded refresh token on re-authentication (RFC 7009)              |
| Autoclaim      | `POST` | `/v1/platform/accountless_applications/claim` | Claims an accountless application by token; returns the full `Application` object |
| Claimed app    | `GET`  | `/v1/platform/applications/{id}`              | Only when the claim response lacks the app's instances or the keys to compare     |

### `clerk auth logout` (aliases: `signout`, `sign-out`)

Revokes the **current environment's** OAuth grant server-side, removes the stored authentication token, and clears auth info from local config.

#### What revocation does and does not cover

- **Does**: invalidates the refresh token for the active environment's session, so it can no longer be redeemed.
- **Does not**: invalidate an outstanding JWT access token. The server refuses to revoke those (`JWT access tokens cannot be revoked`) because a JWT is verified by signature, not by a lookup — it stays usable until it expires.
- **Does not**: touch sessions stored for other environments, the user's dashboard/browser session, or `CLERK_PLATFORM_API_KEY`. Logout warns when that variable is set, since it continues to authenticate requests.

Revocation never blocks logout: the local credentials are deleted whether or not the server was reached. When revocation fails, the command says so and points at the dashboard rather than reporting a clean sign-out. Details are logged under `--verbose`.

Two cases report success without anything actually being revoked server-side, both inherent to RFC 7009 §2.2, which specifies `200` for an unrecognised token: an already-expired session, and a token another process rotated away while the flow was in progress.

#### API Endpoints

| Step   | Method | Endpoint              | Description                                                  |
| ------ | ------ | --------------------- | ------------------------------------------------------------ |
| Revoke | `POST` | `/oauth/token/revoke` | Revokes the stored refresh token for the current environment |
