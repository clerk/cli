# Init Command

> **Partially mocked.** The authentication step (`clerk auth login`) is real. Everything after login — app creation, app selection, and writing API keys to `.env` — is stubbed with debug log output only.

Initializes Clerk in a project by authenticating the user and linking a Clerk application.

## Usage

```sh
clerk init
clerk init --prompt
```

## Options

| Flag | Description |
|---|---|
| `--prompt` | Output an AI agent prompt for integrating Clerk instead of running the interactive flow |

## Flow

1. Authenticates the user via `clerk auth login` (see [auth/README.md](../auth/README.md) for APIs)
2. **New users**: automatically creates a Clerk app and writes API keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) to `.env`
3. **Existing users**: opens the browser to pick or create an app, then writes API keys to `.env`

## API Endpoints

Steps 2 and 3 are not yet wired to real APIs. When implemented, they will likely use:

| Step | Method | Endpoint | Status |
|---|---|---|---|
| Create application | `POST` | `/v1/platform/applications` | Not yet implemented |
| List applications | `GET` | `/v1/platform/applications` | Not yet implemented |
| Fetch API keys | `GET` | `/v1/platform/applications/{appID}/instances/{instanceID}/api_keys` | Not yet implemented |
