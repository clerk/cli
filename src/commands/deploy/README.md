# Deploy Command

> **Fully mocked.** This command uses hardcoded test data and is not yet wired to real APIs. The interactive prompts are real, but all API calls (application lookup, instance creation, DNS, OAuth credential storage) are simulated.

Guides a user through deploying their Clerk application to production.

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant CLI as Clerk CLI
    participant API as Clerk Platform API
    participant DNS as DNS Provider
    participant Browser

    Note over CLI: clerk deploy

    %% Auth & App Check
    Note over CLI: Auth token from local config<br/>(stored during `clerk auth login`)
    CLI->>API: GET /v1/platform/applications/{appID}
    API-->>CLI: { application }

    %% Production Instance Check
    CLI->>API: GET /v1/platform/applications/{appID}/instances/production/config
    alt 200 — production instance exists
        API-->>CLI: { config }
        CLI->>User: Production instance already exists
        Note over CLI: Update flow — TBD
    else 404 — no production instance
        API-->>CLI: 404 Not Found
    end

    %% Read Dev Instance Config (features + social providers)
    CLI->>API: GET /v1/platform/applications/{appID}/instances/development/config
    API-->>CLI: { config_version, connection_oauth_google: {...}, ... }

    %% Subscription Check
    CLI->>API: GET /v1/platform/applications/{appID}/subscription
    API-->>CLI: { id, stripe_subscription_id }
    CLI->>CLI: Compare dev features vs plan features
    alt Unsupported features found
        CLI->>User: Upgrade plan to continue
    end

    %% Domain Selection
    CLI->>User: How would you like to set up your production domain?
    alt Custom domain
        User->>CLI: "Use my own domain"
        CLI->>User: Enter your domain:
        User->>CLI: example.com
    else Clerk subdomain
        User->>CLI: "Use a Clerk-provided subdomain"
    end

    %% Create Production Instance
    Note over CLI,API: No "add production instance" endpoint exists.<br/>Current API only creates instances at app creation.<br/>Needs a new endpoint or re-creation via<br/>POST /v1/platform/applications<br/>with environment_types: ["development","production"]
    CLI->>API: POST /v1/platform/applications (TBD — needs new endpoint?)
    API-->>CLI: { application, instances: [dev, prod] }

    %% Domain Setup
    opt Custom domain selected
        CLI->>API: POST /v1/platform/applications/{appID}/domains
        Note right of API: { name: "example.com",<br/>is_satellite: false }
        API-->>CLI: { domain }

        CLI->>DNS: Lookup NS records for domain
        DNS-->>CLI: { provider, supportsDomainConnect }

        alt Supports Domain Connect
            CLI->>User: Open browser to configure DNS?
            User->>CLI: Yes
            CLI->>Browser: Open Domain Connect URL
        else No Domain Connect
            CLI->>User: Add these DNS records manually
        end

        CLI->>API: POST /v1/platform/applications/{appID}/domains/{domainID}/dns_check
        API-->>CLI: { status }
    end

    %% Social Provider Credential Collection
    Note over CLI: Dev config already fetched above —<br/>check for enabled connection_oauth_* keys

    loop Each enabled social provider (e.g. google)
        CLI->>User: Your app uses {Provider} OAuth. Have credentials?

        alt Walk me through it
            User->>CLI: "Walk me through setting it up"
            CLI->>User: Use these values:<br/>  JS origins: https://example.com<br/>  Redirect URI: https://accounts.example.com/v1/oauth_callback
            CLI->>Browser: Open Clerk docs for provider
            CLI->>User: Enter credentials below:
        else Already have credentials
            User->>CLI: "I already have my credentials"
        end

        CLI->>User: Client ID:
        User->>CLI: {client_id}
        CLI->>User: Client Secret:
        User->>CLI: {client_secret}

        CLI->>API: PATCH /v1/platform/applications/{appID}/instances/production/config
        Note right of API: { connection_oauth_google:<br/>{ enabled: true,<br/>client_id: "...",<br/>client_secret: "..." } }
        API-->>CLI: { before, after, config_version }
    end

    %% Done
    CLI->>User: Production ready at https://{domain}
    CLI->>User: (Redeploy with updated secret keys if needed)
```

## API Endpoints

All endpoints are on the **Platform API** (`/v1/platform/...`).

| Step | Method | Endpoint | Notes |
|---|---|---|---|
| Auth | — | Local config | Token stored from `clerk auth login` |
| Get application | `GET` | `/v1/platform/applications/{appID}` | |
| Check prod instance | `GET` | `.../instances/production/config` | 404 if none exists |
| Read dev config | `GET` | `.../instances/development/config` | Returns all settings including `connection_oauth_*` keys |
| Subscription check | `GET` | `.../subscription` | Returns `{ id, stripe_subscription_id }` only — feature comparison is client-side |
| Create prod instance | `POST` | `/v1/platform/applications` | **Gap: no endpoint to add a production instance to an existing app** |
| Add domain | `POST` | `.../domains` | Body: `{ name, is_satellite }` |
| DNS check | `POST` | `.../domains/{domainID}/dns_check` | Triggers async DNS verification |
| Write OAuth creds | `PATCH` | `.../instances/production/config` | Body: `{ connection_oauth_{provider}: { enabled, client_id, client_secret } }` |

## API Gaps

### Creating a production instance for an existing app

The current Platform API only creates instances during application creation via `POST /v1/platform/applications` with the `environment_types` parameter:

```json
POST /v1/platform/applications
{
  "name": "my-app",
  "environment_types": ["development", "production"],
  "domain": "example.com"
}
```

There is **no endpoint** to add a production instance to an application that was originally created with only a development instance. This needs either:
1. A new `POST /v1/platform/applications/{appID}/instances` endpoint
2. Or a different approach (e.g., re-creating the application)

### Subscription feature comparison

`GET /v1/platform/applications/{appID}/subscription` returns only basic metadata (`id`, `stripe_subscription_id`), not feature lists. Feature detection is done server-side in `pkg/pricing/pricing.go` by inspecting instance config. The CLI would need either:
1. A new endpoint that returns the feature comparison result
2. Or access to plan feature lists to compare client-side

## OAuth Provider Config Format

Config keys follow the pattern `connection_oauth_{provider}`. When writing credentials to a production instance:

```json
PATCH /v1/platform/applications/{appID}/instances/production/config

{
  "connection_oauth_google": {
    "enabled": true,
    "client_id": "123456789-abc.apps.googleusercontent.com",
    "client_secret": "GOCSPX-..."
  }
}
```

### Provider-specific required fields

| Provider | Required Fields |
|---|---|
| Google | `client_id`, `client_secret` |
| GitHub | `client_id`, `client_secret` |
| Microsoft | `client_id`, `client_secret` |
| Apple | `client_id`, `client_secret`, `key_id`, `team_id` |
| Linear | `client_id`, `client_secret` |

Production instances return `422` if you try to enable a provider without credentials.

### Google OAuth `client_id` validation

Google enforces a pattern: `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`

## Helpful values for OAuth walkthrough

When the user chooses the guided walkthrough, these values are derived from their domain:

| Field | Value |
|---|---|
| Authorized JavaScript origins | `https://{domain}`, `https://www.{domain}` |
| Authorized redirect URI | `https://accounts.{domain}/v1/oauth_callback` |
