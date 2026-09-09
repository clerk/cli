# Deploy Command

> **Live PLAPI lifecycle.** Human mode resolves the linked application, production domains, domain status, and instance config from the Platform API on each run. The production-instance lifecycle calls (`instances` and domain `status`) call the helpers in `lib/plapi.ts` directly. PLAPI error codes are translated to typed `CliError`s by `commands/deploy/errors.ts`.

Guides a user through deploying their Clerk application to production.

When the CLI reaches the DNS configuration step, it displays the required CNAME records and then prompts the user to export those records as a BIND zone file (`./clerk-<domain>.zone`). The prompt defaults to "no" and the file is overwritten silently on subsequent runs; `--zone-file <path>` writes the file without prompting. On new deploys, this handoff happens before OAuth setup so DNS propagation can start while the user configures providers.

After the OAuth step (providers can be skipped and stay pending), DNS verification checks DNS, SSL, and email DNS from the same domain status response. The wizard uses one shared exponential-backoff loop instead of waiting for each component separately. If polling times out, the retry handoff lists only DNS records tied to still-pending DNS-backed checks. For example, when DNS and email DNS are verified but SSL is still pending, the CLI shows green checks for the verified components and does not reprint already verified records.

## Usage

```sh
clerk deploy                                    # Interactive, idempotent wizard (human mode)
clerk deploy --domain example.com --yes         # Skip the domain prompt and the confirmations
clerk deploy --domain example.com --no-clone    # Blank production instance, nothing copied from development
clerk deploy --zone-file ./clerk.zone           # Write the DNS records as a BIND zone file, no prompt
clerk deploy --verbose                          # With debug output
clerk deploy --mode agent                       # Read-only JSON report for agents
clerk deploy --domain example.com --mode agent  # Agent mode: create or resume, then print the JSON report
clerk deploy status                             # Verify deploy completion without prompts
clerk deploy status --mode agent --wait         # Agent verification with retrying wait
```

## Options

| Flag                 | Purpose                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `--domain <domain>`  | Production domain you own. Skips the prompt in human mode; required to create in agent mode.              |
| `--no-clone`         | Create a blank production instance instead of cloning development settings (skips the plan's clone gate). |
| `--zone-file <path>` | Write the required DNS records to `<path>` as a BIND zone file without prompting.                         |
| `--yes`              | Skip the proceed, create, and zone-file confirmations (human mode; agent mode never prompts).             |
| `--verbose`          | Show detailed deploy and PLAPI debug output.                                                              |

## Agent Mode

In agent mode (`--mode agent`, `CLERK_MODE=agent`, or a non-TTY context) `clerk deploy` never prompts and emits one JSON report via `log.data` on stdout.

- **Without `--domain`** the run is read-only: it resolves the linked app, production instance, domain, domain status snapshot, and OAuth completeness, but does not mutate config, trigger a DNS check, or poll.
- **With `--domain <domain>`** the run creates the production instance (cloning development unless `--no-clone` is set), persists `instances.production` in the profile, and then emits the same report. If a production instance already exists nothing is created, and a differing `--domain` is reported under `warnings`. Hosting-provider domains such as `*.vercel.app` are rejected with a usage error before any API call. `--no-clone` without `--domain` is a usage error.
- **`--zone-file <path>`** writes the DNS records as a BIND zone file when the domain has records; otherwise it is ignored with an entry in `warnings`.

The report is the `clerk deploy status` report plus:

- `created`: `true` when this run created the production instance.
- `zoneFile`: absolute path of the written zone file, when `--zone-file` was set.
- `warnings`: ignored inputs (`--domain` mismatch, `--zone-file` without records) or a resumed instance that already existed.

The handoff state is one of:

| State                 | Meaning                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_started`         | No production instance exists. `nextAction` asks the agent to get a domain the user owns and run `clerk deploy --domain <domain>`.                                    |
| `domain_provisioning` | A production instance exists, but PLAPI has not returned a production domain yet. Re-run `clerk deploy status`.                                                       |
| `domain_pending`      | A production domain exists, but DNS, SSL, email DNS, or final server-side readiness is pending. `nextAction` says whether records still need adding.                  |
| `oauth_pending`       | The domain is verified, but supported OAuth providers still need production credentials. `oauth.setup[]` carries the exact `clerk config patch` command per provider. |
| `complete`            | Production is deployed and verified. `nextAction` points at `clerk env pull --instance prod --print` for the hosting provider's environment variables.                |

Agent-mode `clerk deploy` exits `0` whenever its own action succeeded, even while DNS or OAuth is still pending. The pass/fail gate is `clerk deploy status`.

### `clerk deploy status`

`clerk deploy status` is the read-only verification command for agents and automation. It resolves the same live deploy state, triggers a DNS check for active production domains, and reports DNS, SSL, email DNS, and OAuth completeness. Human mode waits with the shared exponential-backoff poll loop; agent mode performs one quick DNS check and returns the resulting status immediately by default. Pass `--wait` in agent mode to wait with the same poll loop: one immediate status read, then up to 5 retries with exponential backoff.

In agent mode, `clerk deploy status` emits JSON on stdout with:

- `complete`: `true` only when the domain is verified and all supported OAuth providers enabled in development have production credentials.
- `state`: `complete`, `domain_pending`, `oauth_pending`, `domain_provisioning`, `not_started`, or `interrupted`.
- `domainStatus`: per-component DNS, SSL, and email DNS status when a domain exists.
- `pendingDnsRecords`: CNAME records still tied to pending DNS-backed checks, each with `type`, `host`, `value`, and `required`.
- `oauth`: `configured`, `pending`, and `unsupported` provider slugs, plus `setup`: one entry per pending provider with `configKey`, `fields` (`key`, `label`, `secret`, optional `options` and `fileContents`), `redirectUri`, `authorizedOrigins`, `docsUrl`, `note`, and `command`, the `clerk config patch --instance prod --json '…' --yes` call with `<field>` placeholders.
- `nextAction`: the command or user request that moves the deploy forward. The Clerk Dashboard domains URL appears only as a trailing fallback sentence.

A `setup` entry looks like:

```json
{
  "provider": "github",
  "label": "GitHub",
  "configKey": "connection_oauth_github",
  "fields": [
    { "key": "client_id", "label": "Client ID", "secret": false },
    { "key": "client_secret", "label": "Client Secret", "secret": true }
  ],
  "redirectUri": "https://clerk.example.com/v1/oauth_callback",
  "authorizedOrigins": ["https://example.com", "https://www.example.com"],
  "docsUrl": "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github",
  "note": null,
  "command": "clerk config patch --instance prod --json '{\"connection_oauth_github\":{\"enabled\":true,\"client_id\":\"<client_id>\",\"client_secret\":\"<client_secret>\"}}' --yes"
}
```

Exit codes:

| Exit | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Deploy is complete and verified.                                                              |
| `1`  | The check ran successfully, but deploy is incomplete. Inspect `state` and `nextAction`.       |
| else | A real CLI error occurred, such as not linked or an API failure, via the standard error path. |

Agent mode is detected via the mode system (`src/mode.ts`), which checks in priority order:

1. `--mode` CLI flag
2. `CLERK_MODE` environment variable
3. TTY detection (`process.stdout.isTTY`)

The human-mode wizard still starts only in human mode.

## PLAPI Lifecycle

Human mode reads and writes deploy state through the Platform API on every run. The CLI does not persist deploy progress locally; the only profile write is the ordinary `instances.production` value once the production instance has been created.

| Step                       | Endpoint                                                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create production instance | `POST /v1/platform/applications/{appID}/instances`                          | Returns `id`, `environment_type`, `active_domain`, `publishable_key`, `secret_key` (once), and timestamps. DNS records are read from `active_domain.cname_targets[]`. `--no-clone` omits `clone_instance_id`, which also skips the clone feature check.                                                                                                                                                 |
|                            |                                                                             | Performs clone feature compatibility validation before creating production resources. 402 `unsupported_subscription_plan_features` → `ERROR_CODE.PLAN_INSUFFICIENT` listing missing features, with a `clerk deploy --domain <domain> --no-clone` retry example attached. 409 `production_instance_exists` → CLI re-derives state via `fetchApplication` and falls through to `reconcileExistingDeploy`. |
| Trigger domain DNS check   | `POST /v1/platform/applications/{appID}/domains/{domainIDOrName}/dns_check` | Starts a server-side DNS check. `clerk deploy status` triggers this before resolving the live state. Agent-mode `clerk deploy status` returns after the post-trigger status snapshot by default; `--wait` polls active production domains with the shared retry loop. A 409 conflict means a check is already running.                                                                                  |
| Poll domain status         | `GET /v1/platform/applications/{appID}/domains/{domainIDOrName}/status`     | Returns aggregate `status` plus nested DNS, SSL, email DNS, and proxy component status. The CLI drives one shared DNS verification loop over the full status response. The aggregate `status` guards proxy and other server-side readiness gates. It performs one immediate status read, then polls every 3s.                                                                                           |
| Save OAuth credentials     | `PATCH /v1/platform/applications/{appID}/instances/{instanceID}/config`     | Returns the updated config snapshot. Used to persist production `connection_oauth_*` credentials.                                                                                                                                                                                                                                                                                                       |

After displaying the DNS records block, when CNAME records are present the CLI prompts "Export DNS records as a BIND zone file? (y/N)". On yes, it writes `./clerk-<domain>.zone` in the current working directory. The file is a standard BIND fragment containing `$ORIGIN`, `$TTL 300`, and one fully-qualified CNAME per record. The default is "no" and the file is overwritten silently on subsequent runs. Most major DNS providers (Cloudflare, Route 53, Google Cloud DNS, and others) support importing BIND zone fragments. The same prompt appears on both new deploys and resumed deploys. `--zone-file <path>` writes the file to `<path>` without prompting (in agent mode too, reported as `zoneFile`), and `--yes` keeps the prompt's default answer of no.

PLAPI errors are translated to typed `CliError`s by `commands/deploy/errors.ts`. The CLI does not auto-retry SSL issuance or email DNS verification beyond the shared DNS verification loop. When domain status polling times out with SSL or email DNS still incomplete, the CLI surfaces the component status and instructs the user to rerun `clerk deploy` once DNS propagates.

If the user presses Ctrl-C after the production instance has been created — at a prompt or during the DNS wait — the wizard tells them to run `clerk deploy` again and exits with SIGINT code 130. The deploy is unfinished either way, so `clerk deploy && ./cutover.sh` stops rather than proceeding against a half-configured instance. The next run derives the current DNS or OAuth step from API state and resumes without starting another production instance.

`clerk deploy status` also exits 130 on Ctrl-C, and always emits a report on the way out. Interrupted mid-wait, it reports what the last completed poll established. Interrupted before the live state resolves — during the preflight DNS check or the state read — it reports `state: "interrupted"`, which asserts nothing about the deploy. See [`.claude/rules/interrupts.md`](../../../../../.claude/rules/interrupts.md).

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
    CLI->>API: GET /v1/platform/applications/{appID}/instances/{dev_instance_id}/config/schema?keys=connection_oauth_google,...
    API-->>CLI: { properties: { connection_oauth_google: { properties: ... } } }

    %% Plan summary + domain
    CLI->>User: Plan summary
    CLI->>User: Production domain (e.g. example.com)
    User->>CLI: example.com

    %% Create production instance + domain in one round-trip, including clone validation
    CLI->>API: POST /v1/platform/applications/{appID}/instances { domain, environment_type, clone_instance_id }
    API-->>CLI: { id, active_domain: { id, name, cname_targets }, publishable_key, secret_key }

    CLI->>User: Add these CNAME records to your DNS provider

    %% OAuth credential loop
    loop Each supported schema-backed OAuth provider
        CLI->>User: Provider credentials
        CLI->>API: PATCH /v1/platform/applications/{appID}/instances/{instance_id}/config { connection_oauth_{provider} }
        API-->>CLI: { before, after, config_version }
    end

    %% Poll domain status
    loop every 3s until status == "complete"
        CLI->>API: GET /v1/platform/applications/{appID}/domains/{domain_id_or_name}/status
        API-->>CLI: { status, dns, ssl, mail, proxy }
    end

    CLI->>User: Production ready at https://{domain}
```

## API Endpoints

All endpoints are on the **Platform API** (`/v1/platform/...`) and are live HTTP calls. The deploy command calls the helpers in `lib/plapi.ts` directly.

| Step                        | Method  | Endpoint                                                                 | Helper                                                                                                                                           |
| --------------------------- | ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                        | n/a     | Local config                                                             | Token stored from `clerk auth login` or `CLERK_PLATFORM_API_KEY`.                                                                                |
| Read instance config        | `GET`   | `/v1/platform/applications/{appID}/instances/{instanceID}/config`        | `fetchInstanceConfig` from `lib/plapi.ts`. Discovers enabled `connection_oauth_*` providers.                                                     |
| Read instance config schema | `GET`   | `/v1/platform/applications/{appID}/instances/{instanceID}/config/schema` | `fetchInstanceConfigSchema`. Reads schemas for supported OAuth config keys so deploy can derive credential prompts.                              |
| Patch instance config       | `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config`        | `patchInstanceConfig`. Writes production OAuth credentials.                                                                                      |
| Read application            | `GET`   | `/v1/platform/applications/{appID}`                                      | `fetchApplication`. Resolves development and production instance IDs.                                                                            |
| List production domains     | `GET`   | `/v1/platform/applications/{appID}/domains`                              | `listApplicationDomains`. Recovers production domain name and CNAME targets on each run.                                                         |
| Create production instance  | `POST`  | `/v1/platform/applications/{appID}/instances`                            | `createProductionInstance`. Returns prod instance, primary domain, keys, and DNS records nested under `active_domain.cname_targets[]`.           |
| Trigger domain DNS check    | `POST`  | `/v1/platform/applications/{appID}/domains/{domainIDOrName}/dns_check`   | `triggerApplicationDomainDNSCheck`. Called by the wizard and by `clerk deploy status`; agent mode waits briefly, then reads one status snapshot. |
| Poll domain status          | `GET`   | `/v1/platform/applications/{appID}/domains/{domainIDOrName}/status`      | `getApplicationDomainStatus`. Drives the wizard spinner and the human-mode `clerk deploy status` wait loop over the full domain status response. |

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

### OAuth provider support

`clerk deploy` discovers enabled built-in OAuth providers from development config keys named `connection_oauth_{provider}`. For public built-in providers supported by the deploy flow, the command reads `GET /config/schema` and derives credential prompts from the provider schema.

Most providers ask for `client_id` and `client_secret`. Provider-specific schema fields are prompted when they are safe for deploy setup, such as Linear `actor`.

Skipping a provider ("Skip for now") does not pause the deploy: the wizard continues to DNS verification and the final summary lists the provider under `Pending`. Credentials can be added later by rerunning `clerk deploy` or with `clerk config patch --instance prod --json '{"connection_oauth_<provider>":{"enabled":true,…}}' --yes`; `clerk deploy status` keeps reporting `oauth_pending` until then. Interrupting a prompt with Ctrl-C still pauses.

The CLI keeps small local overrides for provider setup details that schema does not fully describe:

| Provider | Override                                                                                   |
| -------- | ------------------------------------------------------------------------------------------ |
| Google   | Optional Google Cloud Console JSON import and OAuth consent screen warning                 |
| Apple    | `.p8` file import, production-required `team_id` and `key_id`, native-only field omissions |

For Google, the wizard can load `client_id` and `client_secret` from the top-level `web` object in a Google Cloud Console OAuth client JSON file, or from `installed` for desktop-style client downloads. The file contents are used in memory and are not written to CLI config.

Providers not currently supported by automated deploy setup are cloned to production without automated credential setup. Configure those providers from the Clerk Dashboard before going live.

Production instances return `422` if you try to enable a provider without credentials.

## Helpful values for OAuth walkthrough

When the user chooses the guided walkthrough, these values are derived from their domain:

| Field                         | Value                                      |
| ----------------------------- | ------------------------------------------ |
| Authorized JavaScript origins | `https://{domain}`, `https://www.{domain}` |
| Authorized redirect URI       | `{frontend_api_url}/v1/oauth_callback`     |

The redirect URI is served by the Frontend API (`clerk.{domain}`), not the Account
Portal (`accounts.{domain}`). Use the `frontend_api_url` returned on the domain
object rather than reconstructing it from the domain name.
