# Auth Commands

Manage authentication with Clerk.

## Commands

### `clerk auth login`

Authenticates the user via an OAuth 2.0 PKCE flow.

1. Checks for an existing valid token and skips login if found
2. Generates PKCE parameters (code verifier, challenge, state)
3. Starts a local HTTP callback server on `127.0.0.1`
4. Opens the browser to the Clerk OAuth authorization URL
5. Waits for the redirect callback with an authorization code
6. Exchanges the code for an access token
7. Stores the token and user info in local config

#### API Endpoints

All requests are made against the Clerk OAuth system instance (default `https://clerk.clerk.com`, overridable via `CLERK_OAUTH_BASE_URL`).

| Step | Method | Endpoint | Description |
|---|---|---|---|
| Authorize | `GET` | `/oauth/authorize` | Browser redirect with PKCE `code_challenge`, `state`, `client_id`, `redirect_uri` |
| Token exchange | `POST` | `/oauth/token` | Exchanges authorization code + `code_verifier` for an access token |
| User info | `GET` | `/oauth/userinfo` | Fetches `sub` (user ID) and `email` using the access token |

### `clerk auth logout`

Removes the stored authentication token and clears auth info from local config. No API calls are made.
