# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login` (aliases: `signup`, `signin`, `sign-in`)

Authenticates the user via an OAuth 2.0 PKCE flow.

1. Checks for an existing valid token — if found, prompts to re-authenticate (in agent mode, skips login silently)
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Opens the browser to the Clerk OAuth authorization URL
5. Waits for the redirect callback with an authorization code
6. Exchanges the code for an access token
7. Stores the token and user info in local config

#### API Endpoints

All requests are made against the Clerk OAuth system instance (default `https://clerk.clerk.com`, overridable via `CLERK_OAUTH_BASE_URL`).

| Step           | Method | Endpoint           | Description                                                                       |
| -------------- | ------ | ------------------ | --------------------------------------------------------------------------------- |
| Authorize      | `GET`  | `/oauth/authorize` | Browser redirect with PKCE `code_challenge`, `state`, `client_id`, `redirect_uri` |
| Token exchange | `POST` | `/oauth/token`     | Exchanges authorization code + `code_verifier` for an access token                |
| User info      | `GET`  | `/oauth/userinfo`  | Fetches `sub` (user ID) and `email` using the access token                        |

## Non-interactive authentication — `CLERK_CLI_TOKEN`

Set the `CLERK_CLI_TOKEN` environment variable to a valid CLI access token to bypass the OAuth browser flow entirely. When set, the CLI uses this token for all authenticated requests without prompting for login.

This is intended for CI/CD pipelines, automated scripts, and running the e2e test suite where interactive login is not possible. The token takes priority over any token stored by `clerk auth login`.

```sh
CLERK_CLI_TOKEN=<token> clerk <command>
```

#### How to obtain a token

The `CLERK_CLI_TOKEN` is an OAuth access token issued by [clerk.clerk.com](https://clerk.clerk.com). To get one:

1. Run `clerk auth login` interactively to complete the OAuth flow
2. The CLI stores the resulting token in your OS keychain (service: `clerk-cli`, account: `oauth-access-token`) or, if the keychain is unavailable, in a plaintext credentials file (chmod 600)
3. Extract the token from whichever store was used:
   - **macOS Keychain**: open Keychain Access and search for `clerk-cli`, or use `security find-generic-password -s clerk-cli -a oauth-access-token -w`
   - **Credentials file**: `~/Library/Application Support/clerk-cli/credentials` on macOS, `~/.local/share/clerk-cli/credentials` on Linux (overridable via `CLERK_CONFIG_DIR`)

Set the extracted value as `CLERK_CLI_TOKEN` in your CI secrets or local environment.

### `clerk auth logout` (aliases: `signout`, `sign-out`)

Removes the stored authentication token and clears auth info from local config. No API calls are made.
