# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login` (aliases: `signup`, `signin`, `sign-in`)

Authenticates the user via an OAuth 2.0 PKCE flow. After a successful login (or when an existing session is detected in agent mode), the command attempts to automatically claim any accountless application previously created by `clerk init`.

Before signing in, the command prints a banner: the Clerk logo beside a link to the Clerk docs and the CLI version, plus the active environment (e.g. `staging`) when it isn't production. It's drawn by `lib/banner.ts`, and only from this command's action, so `init`, `link`, and `doctor`, which call `login()` mid-flow, don't print it. The banner is skipped in agent mode, when stderr isn't a terminal, in CI, and when `CLERK_NO_BANNER` is set. `NO_COLOR` prints it without color.

1. Checks for an existing valid token — if found, prompts to re-authenticate (in agent mode, skips and runs autoclaim immediately). When the folder has an init token, a person gets the claim question below instead, unless `-y` is passed
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Prints the Clerk OAuth authorization URL and opens the browser to it. The URL is always printed as a manual fallback for environments where browser launch is unreliable (WSL2, SSH, headless shells). In WSL, the Windows host browser is reached via `wslview` or, when that is not installed, the always-present `powershell.exe` interop binary (`Start-Process`).
5. Waits for the authorization code. In an interactive terminal (human mode with a TTY stdin), it also shows a paste prompt alongside the loopback wait, and whichever delivers a code first wins. The prompt is for machines without a browser: sign in on another device, where the redirect to `127.0.0.1` fails to load, then paste that URL from the address bar. Only the full redirect URL is accepted. It passes the same checks as the loopback redirect, including `state`, so a code from someone else's sign-in is refused. The code is useless without the PKCE verifier, which never leaves the process. Agents, pipes, and CI wait on the loopback only
6. Exchanges the code for an access token
7. Stores the token and user info in local config
8. If this was a re-authentication over an existing session, revokes the previous grant. The outgoing session is read once the authorization code arrives and just before the token exchange replaces it, and revoked only after the replacement is stored — so an abandoned browser flow leaves the original session intact, and a concurrent refresh has the smallest possible window to rotate the token out from under the revocation. A failure here warns rather than failing the login
9. **Autoclaim**: if `.clerk/keyless.json` exists in the current directory, claims the temporary application, after a person answers Yes to the claim question. It then links it to the project and pulls environment variables only when the folder's keys belong to that application, or the folder has no Clerk keys (see below)

#### A person is asked before the claim

A person is asked one question before any claim, naming where the claim will put the app (default Yes), e.g. "Claim `my-app` (the app `clerk init` created in this folder) into jane@example.com's account?". The name is the one the claim gives the app: the `package.json` name, else the folder's. `CLERK_PLATFORM_API_KEY`, when set, authenticates every Platform API call including the claim, so the question then names "the workspace your `CLERK_PLATFORM_API_KEY` belongs to", and never offers to sign in as someone else, since that wouldn't change the destination.

| Credentials         | When it asks                   | Yes                                                 | No                                                                                                            |
| ------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Stored session only | In place of "Re-authenticate?" | Claims with the current session; no browser sign-in | Signs in again in the browser (perhaps as someone else), then asks again about the account just signed into   |
| Session and API key | In place of "Re-authenticate?" | Claims with the key; no browser sign-in             | Ends as a user abort (exit 0), with nothing claimed, and says how to claim into the signed-in account instead |
| API key only        | Before any browser step        | Claims with the key; no browser sign-in             | Signs in in the browser without claiming, and says the key decides where claims go                            |
| Signed out          | After the browser sign-in      | Claims                                              | The sign-in stands                                                                                            |

The init token is read once, at the start of the login, and only that token is claimed. A token that appears during the browser sign-in (say, a signed-out `clerk init` in another terminal), or replaces the one asked about while the question is open, waits for the next login; this holds for agents and `-y` too. A malformed token file is warned about and deleted at that first read.

A No after a sign-in has happened keeps that sign-in, so the login exits 0. The output says the app is still unclaimed and its claim token stays in the folder; the next step is to run `clerk auth login` again, which asks again. A folder without an init token gets "Re-authenticate?" as before. `-y` signs in again and then claims, without asking. Agents can't answer a question, so they claim without one. Commands that sign in on their way to linking (`clerk link` itself, `clerk init`, and `clerk migrate import` when it links next) pass `claim: false` to `login()`, which skips both the question and the claim and doesn't read the token file at all: `clerk link` claims under the same rule. `clerk migrate import --app` links nothing, so login's own claim and its question stay on. The claim's report (what was claimed, what happened to the folder, and the next steps) lives in `claim-report.ts`, shared with `clerk link`.

Known limitations:

- The question names the account signed in when it's asked. Signing in as someone else in another terminal before answering changes where Yes claims to.
- The email names the person, not the workspace. A claim made with a signed-in session lands in the workspace that sign-in used, so for someone in both a personal and a company workspace it can land in either.

#### Accountless autoclaim breadcrumb lifecycle

When `clerk init` runs in accountless mode it writes `.clerk/keyless.json` containing a claim token. On the next `clerk auth login`:

- **404** — claim token expired or application already deleted; breadcrumb is cleared and a warning is shown.
- **403** — authenticated account has no active organization; breadcrumb is cleared and a warning is shown.
- **Any other error** — treated as transient; breadcrumb is preserved so the next login retries.
- **Success** — application is claimed and the breadcrumb is deleted, unless it now holds a different token (written since the login read it), which is kept for the next login. The command prints the Dashboard URL of the claimed app's development instance, since this is the first time the app has a home in an account. What happens to the folder depends on what it already holds:
  - **No Clerk keys, or only keys that belong to the claimed app** — the folder is linked to it and its keys are written via `clerk env pull`, into the same folder.
  - **Linked to a different app** — the link and env files are left alone. The warning names the linked app and the command to switch: `clerk link --app <claimed app id>`.
  - **A key that isn't the claimed app's** — the link and env files are left alone. The warning names the variable and where it came from (never its value), preferring the key the app loads, and says only what the CLI established:
    - plain `clerk link` is suggested ("it tries to match that key to an application in your account") only when the folder isn't linked, its keys don't mix apps, and the key is the publishable key `clerk link` would match with;
    - otherwise: choose the application, with `clerk apps list --json` for the IDs and `clerk link --app <app_id>`;
    - keys from the claimed app and another app: make the folder's keys belong to one app first.
  - **Can't tell** (a key line the CLI's env parser can't read, such as an indented line or spaces around `=`; a value that isn't shaped like a Clerk key, such as one with a trailing comment or a `${VAR}` reference; a key that can't be decoded; an env file that can't be read; an error looking up the folder's link; an SDK keyless file that can't be read or holds no key; or an app whose keys can't be fetched) — the link and env files are left alone. The warning offers `clerk apps list --json` with `clerk link --app <app_id>`, or `clerk link --app <claimed app id>`. A readable key from another app still takes precedence, as "a key that isn't the claimed app's".
  - **Linking fails** — printed after the claim line, with the reason.

  Every Clerk key the folder holds is compared, not just the one its app loads: keys in the shell and in `.env`, `.env.development`, `.env.local`, and `.env.development.local`, under every variable name a supported Clerk SDK reads (from the framework table, whichever framework is detected) and the generic ones. `clerk env pull` picks its own file to write (`.env.development.local` first), always one of those four, so a key left uncompared could otherwise be the one it replaces. A framework the CLI doesn't support, with its own variable prefix, isn't compared. The SDK's `.clerk/.tmp/keyless.json` counts only when there's no plain key of either kind. A publishable key matches when it is one of the claimed app's keys or decodes to the same Frontend API host; a secret key matches only when it is identical, and is compared in memory, never logged. The check runs after the claim because the breadcrumb holds only a token, with no app identity; a mismatched app still lands in the account, which is harmless. When the claim response lacks the app's instances or the keys to compare, the app is fetched once (`GET /v1/platform/applications/{id}`) and that copy is used throughout. The warnings name the next command themselves, because agents never see the closing next steps.

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
