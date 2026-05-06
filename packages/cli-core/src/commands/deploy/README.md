# Deploy Command

> **Mostly mocked.** Deploy lifecycle endpoints (`validate_cloning`, `production_instance`, `deploy_status`, `ssl_retry`, `mail_retry`) plus the production-instance config PATCH are mocked locally with the exact request/response shapes from the real Platform API, so swapping each to a live call is a one-import change in `commands/deploy/api.ts`. Production-targeted writes have to stay mocked while the production instance itself (`ins_prod_mock`) is a fake. The only real PLAPI call today is `fetchInstanceConfig` against the development instance for OAuth provider discovery.

Guides a user through deploying their Clerk application to production.

## Usage

```sh
clerk deploy              # Interactive wizard (human mode)
clerk deploy --debug      # With debug output
clerk deploy --continue   # Resume a paused deploy operation
clerk deploy --abort      # Clear a paused deploy operation after confirmation
clerk deploy --mode agent # Output agent prompt instead of interactive flow
```

## Options

| Flag         | Purpose                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--debug`    | Show detailed mocked Platform API debug output.                                                                                                                                  |
| `--continue` | Resume the DNS or OAuth step saved in local CLI config. Reports "no paused operation" when none exists; reports a project mismatch when the bookmark belongs to another project. |
| `--abort`    | Confirm, then clear the saved paused deploy operation. Reports "no paused operation" when none exists; leaves server-side changes as-is.                                         |

## Agent Mode

> **TODO:** The `DEPLOY_PROMPT` string is hardcoded. It should probably fetch from the quickstart prompt in the Clerk docs instead.

When running in agent mode (`--mode agent`, `CLERK_MODE=agent`, or non-TTY context), this command outputs a structured prompt describing the full deployment flow instead of running the interactive wizard. The prompt includes:

- Prerequisites and pre-flight checks
- Production domain collection and DNS setup
- Production instance creation steps
- OAuth credential collection for social providers
- All relevant Platform API endpoints

Agent mode is detected via the mode system (`src/mode.ts`), which checks in priority order:

1. `--mode` CLI flag
2. `CLERK_MODE` environment variable
3. TTY detection (`process.stdout.isTTY`)

Agent mode does not call PLAPI. It prints `DEPLOY_PROMPT` and exits before the human-mode mocked wizard starts. The prompt currently contains some stale endpoint guidance; see the TODO above `DEPLOY_PROMPT` in `index.ts` and `DEPLOY_MVP_UX_COPY_SPEC.md` §8.3.

## Mocked PLAPI Calls

Human mode calls the helpers in `commands/deploy/api.ts`. They use the exact request/response shapes published in the Platform API OpenAPI spec, but the bodies are produced locally rather than sent over the network. Real implementations should replace each helper one at a time without touching the call sites.

| Step                       | Endpoint                                                                     | Mocked behavior                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Validate cloning           | `POST /v1/platform/applications/{appID}/validate_cloning`                    | Resolves to 204; the helper exists so 402 `UnsupportedSubscriptionPlanFeatures` errors short-circuit before plan confirmation. |
| Create production instance | `POST /v1/platform/applications/{appID}/production_instance`                 | Returns `instance_id`, `environment_type`, `active_domain`, `publishable_key`, `secret_key`, and `cname_targets[]`.            |
| Poll deploy status         | `GET /v1/platform/applications/{appID}/instances/{envOrInsID}/deploy_status` | Returns `incomplete` for the first two polls per `(appID, instanceID)` pair, then `complete`. CLI polls every 3s.              |
| Retry SSL provisioning     | `POST /v1/platform/applications/{appID}/domains/{domainIDOrName}/ssl_retry`  | Resolves to 204; helper exposed for use when `deploy_status` stalls.                                                           |
| Retry mail verification    | `POST /v1/platform/applications/{appID}/domains/{domainIDOrName}/mail_retry` | Resolves to 204; helper exposed for use when `deploy_status` stalls.                                                           |
| Save OAuth credentials     | `PATCH /v1/platform/applications/{appID}/instances/{instanceID}/config`      | Resolves to `{}` without hitting the network. Mocked alongside the others while the production instance itself is a fake.      |

Local paused deploy state is written to the CLI config profile, not PLAPI. `--abort` only clears that local bookmark and does not undo anything already saved to a Clerk production instance. The production `home_url` collected during the wizard lives only on the deploy bookmark (`profile.deploy.domain`); it isn't mirrored onto `profile.instances`, so the bookmark is the single source of truth while the wizard is in flight. Re-running plain `clerk deploy` after the bookmark has been cleared and `instances.production` is set errors with guidance to run `clerk env pull --instance prod` instead.

Mocked endpoints in `commands/deploy/api.ts` pause for ~2s before returning so spinners and the deploy-status poll feel like real network calls. Real implementations remove the artificial delay.

If the user presses Ctrl-C after the production instance has been created, the wizard saves the current DNS or OAuth step as a paused operation, prints the `clerk deploy --continue` recovery command, and exits with SIGINT code 130. Running plain `clerk deploy` while that bookmark exists exits with an error instead of starting another deploy.

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant CLI as Clerk CLI
    participant API as Clerk Platform API
    participant Browser

    Note over CLI: clerk deploy

    %% Auth & app context
    Note over CLI: Auth token from local config<br/>(stored during `clerk auth login`)

    %% Discover enabled OAuth providers in dev
    CLI->>API: GET /v1/platform/applications/{appID}/instances/{dev_instance_id}/config?keys=connection_oauth_*
    API-->>CLI: { connection_oauth_google: { enabled: true }, ... }

    %% Pre-flight subscription check
    CLI->>API: POST /v1/platform/applications/{appID}/validate_cloning { clone_instance_id }
    alt 402 Payment Required
        API-->>CLI: UnsupportedSubscriptionPlanFeatures
        CLI->>User: Upgrade plan to continue
    else 204 No Content
        API-->>CLI: ok
    end

    %% Plan summary + domain
    CLI->>User: Plan summary
    CLI->>User: Production domain (e.g. example.com)
    User->>CLI: example.com

    %% Create production instance + domain in one round-trip
    CLI->>API: POST /v1/platform/applications/{appID}/production_instance { home_url, clone_instance_id }
    API-->>CLI: { instance_id, active_domain, publishable_key, secret_key, cname_targets }

    CLI->>User: Add these CNAME records to your DNS provider

    %% Poll deploy status
    loop every 3s until status == "complete"
        CLI->>API: GET /v1/platform/applications/{appID}/instances/{instance_id}/deploy_status
        API-->>CLI: { status: "incomplete" | "complete" }
    end

    opt Stalled provisioning
        alt SSL stalled
            CLI->>API: POST /v1/platform/applications/{appID}/domains/{domain_id_or_name}/ssl_retry
            API-->>CLI: 204
        else Mail stalled
            CLI->>API: POST /v1/platform/applications/{appID}/domains/{domain_id_or_name}/mail_retry
            API-->>CLI: 204
        end
    end

    %% OAuth credential loop
    loop Each enabled social provider
        CLI->>User: Provider credentials
        CLI->>API: PATCH /v1/platform/applications/{appID}/instances/{instance_id}/config { connection_oauth_{provider} }
        API-->>CLI: { before, after, config_version }
    end

    CLI->>User: Production ready at https://{domain}
```

## API Endpoints

All endpoints are on the **Platform API** (`/v1/platform/...`). The "Real" rows are live HTTP calls today; the "Mock" rows are wired through `commands/deploy/api.ts` with shapes that match the published OpenAPI spec exactly.

| Step                       | Method  | Endpoint                                                                 | Status | Helper                                                                                                                                     |
| -------------------------- | ------- | ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                       | n/a     | Local config                                                             | Real   | Token stored from `clerk auth login` or `CLERK_PLATFORM_API_KEY`.                                                                          |
| Read instance config       | `GET`   | `/v1/platform/applications/{appID}/instances/{instanceID}/config`        | Real   | `fetchInstanceConfig` from `lib/plapi.ts`. Used to discover enabled `connection_oauth_*` providers in dev.                                 |
| Patch instance config      | `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config`        | Real   | `patchInstanceConfig` from `lib/plapi.ts`. Writes production OAuth credentials.                                                            |
| Validate cloning           | `POST`  | `/v1/platform/applications/{appID}/validate_cloning`                     | Mock   | `validateCloning` in `commands/deploy/api.ts`. Pre-flights subscription/feature support before plan summary.                               |
| Create production instance | `POST`  | `/v1/platform/applications/{appID}/production_instance`                  | Mock   | `createProductionInstance` in `commands/deploy/api.ts`. Returns prod instance, primary domain, keys, and `cname_targets[]`.                |
| Poll deploy status         | `GET`   | `/v1/platform/applications/{appID}/instances/{envOrInsID}/deploy_status` | Mock   | `getDeployStatus` in `commands/deploy/api.ts`. CLI polls every 3 seconds while the production instance is provisioning DNS, SSL, and mail. |
| Retry SSL provisioning     | `POST`  | `/v1/platform/applications/{appID}/domains/{domainIDOrName}/ssl_retry`   | Mock   | `retryApplicationDomainSSL` in `commands/deploy/api.ts`. Available for surfacing to the user when `deploy_status` stalls.                  |
| Retry mail verification    | `POST`  | `/v1/platform/applications/{appID}/domains/{domainIDOrName}/mail_retry`  | Mock   | `retryApplicationDomainMail` in `commands/deploy/api.ts`. Same as above, for SendGrid mail. Rejected on satellite domains.                 |

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

| Provider  | Required Fields                                                  |
| --------- | ---------------------------------------------------------------- |
| Google    | `client_id`, `client_secret`                                     |
| GitHub    | `client_id`, `client_secret`                                     |
| Microsoft | `client_id`, `client_secret`                                     |
| Apple     | `client_id`, `team_id`, `key_id`, `client_secret` (.p8 contents) |
| Linear    | `client_id`, `client_secret`                                     |

Production instances return `422` if you try to enable a provider without credentials.

### Google OAuth `client_id` validation

Google enforces a pattern: `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$`

### Google OAuth JSON import

For Google, the wizard offers `Load credentials from a Google Cloud Console JSON file`. It reads the `client_id` and `client_secret` from the top-level `web` object in the downloaded OAuth client JSON, or from `installed` for desktop-style client downloads. The file contents are used in memory and are not written to CLI config.

## Helpful values for OAuth walkthrough

When the user chooses the guided walkthrough, these values are derived from their domain:

| Field                         | Value                                         |
| ----------------------------- | --------------------------------------------- |
| Authorized JavaScript origins | `https://{domain}`, `https://www.{domain}`    |
| Authorized redirect URI       | `https://accounts.{domain}/v1/oauth_callback` |
