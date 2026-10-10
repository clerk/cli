# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login` (aliases: `signup`, `signin`, `sign-in`)

Authenticates the user via an OAuth 2.0 PKCE flow. After a successful login (or when an existing session is detected in agent mode), the command attempts to automatically claim any accountless application previously created by `clerk init`.

1. Checks for an existing valid token — if found, prompts to re-authenticate (in agent mode, skips and runs autoclaim immediately)
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Prints the Clerk OAuth authorization URL and opens the browser to it. The URL is always printed as a manual fallback for environments where browser launch is unreliable (WSL2, SSH, headless shells). In WSL, the Windows host browser is reached via `wslview` or, when that is not installed, the always-present `powershell.exe` interop binary (`Start-Process`).
5. Waits for the redirect callback with an authorization code
6. Exchanges the code for an access token
7. Stores the token and user info in local config
8. If this was a re-authentication over an existing session, revokes the previous grant. The outgoing session is read once the authorization code arrives and just before the token exchange replaces it, and revoked only after the replacement is stored — so an abandoned browser flow leaves the original session intact, and a concurrent refresh has the smallest possible window to rotate the token out from under the revocation. A failure here warns rather than failing the login
9. **Autoclaim**: if `.clerk/keyless.json` exists in the current directory, claims the temporary application, links it to the project, and pulls environment variables

#### Accountless autoclaim breadcrumb lifecycle

When `clerk init` runs in accountless mode it writes `.clerk/keyless.json` containing a claim token. On the next `clerk auth login`:

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
| Revoke         | `POST` | `/oauth/token/revoke`                         | Revokes the superseded refresh token on re-authentication (RFC 7009)              |
| Autoclaim      | `POST` | `/v1/platform/accountless_applications/claim` | Claims an accountless application by token; returns the full `Application` object |

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
