# `clerk users`

Manage direct Clerk user resources with first-class commands. Use `clerk api` for unsupported or fully custom user requests.

## Shared Targeting And Auth

Most `clerk users` commands accept the same targeting flags:

| Flag               | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| `--secret-key <k>` | Use a specific Backend API secret key directly                                    |
| `--app <id>`       | Target an application directly, even outside a linked project                     |
| `--instance <id>`  | Target `dev`, `prod`, or a full instance ID. Defaults to the development instance |
| `--dry-run`        | Preview the request without executing it, where supported                         |
| `--yes`            | Skip confirmation prompts for mutating commands                                   |

Authentication is resolved in this order:

- `--app <id>` plus Platform API auth to resolve the instance secret key
- `--secret-key <key>`
- `CLERK_SECRET_KEY`
- a linked project profile via `clerk link`

The users commands talk to the instance's Backend API. Identifier and required-field rules are enforced by BAPI, so any BAPI secret key (via `CLERK_SECRET_KEY`, `--secret-key`, or `--app`-resolved) is enough — no `applications:manage` Platform API scope is required.

## Interactive mode

In human mode (TTY), `clerk users` invoked with no subcommand opens an interactive menu that lists every registered action and dispatches to its handler.

`clerk users create` invoked without curated flags or `--input-json` / `-d` / `--file` enters a guided wizard. The wizard fetches the instance's Frontend API configuration to prompt only for fields the instance accepts (and marks required fields). When run with `--secret-key` only (no app context), the wizard falls back to prompting the full curated-flag set as optional and lets the Backend API validate.

In agent mode all interactive flows are disabled and the same invocations exit with a structured usage error.

## Passing input as JSON

Two complementary mechanisms for JSON input work across the users command family:

- **`--input-json <json|@file|->`** (program-level). Expands JSON object keys into argv flags before Commander parses them. Drive the curated flags with structured JSON, from an agent or a pipeline: `clerk users create --input-json '{"email":"alice@example.com","first-name":"Alice","yes":true}'`. Accepts inline JSON, `@path/to/file.json`, or `-` for stdin. Piped stdin is auto-detected when `--input-json` is absent.
- **`-d, --data <json>` plus `--file <path>`** (per-command). Send a raw BAPI request body directly to `/v1/users`. Use this when you need a BAPI field the curated flags don't expose (for example, `primary_email_address_id` or `web3_wallets`). Mirrors `clerk api -d` / `--file`.

## Commands

### `clerk users list`

List users from the target instance. In human mode without a linked project, an env var, or a targeting flag, the command opens the same application picker as `clerk users create` so you can choose an instance interactively.

```sh
clerk users list
clerk users list --json
clerk users list --query alice --limit 20 --offset 40
clerk users list --email-address alice@example.com --phone-number +15551234567
clerk users list --user-id user_123 --external-id crm_123 --order-by -last_sign_in_at
clerk users list --app app_123 --instance prod
```

Common list filters:

- `--limit <number>`
- `--offset <number>`
- `--query <query>`
- `--email-address <email>` repeat or comma-separate values
- `--phone-number <phone>` repeat or comma-separate values
- `--username <username>` repeat or comma-separate values
- `--user-id <user-id>` repeat or comma-separate values
- `--external-id <external-id>` repeat or comma-separate values
- `--order-by <field>` supports Clerk's common `getUserList()` order fields, with optional `+` or `-`

### `clerk users create`

Create a user from curated flags or a raw BAPI request body via `-d` or `--file`. By default, human mode prints a terse success message; pass `--json` for the response body.

```sh
clerk users create --email alice@example.com --first-name Alice --yes
clerk users create --app app_123 --instance prod -d '{"email_address":["alice@example.com"]}' --yes
clerk users create --app app_123 --instance prod -d '{"email_address":["alice@example.com"]}' --json --yes
clerk users create --file user.json --dry-run
```

Supported curated flags:

- `--email <email>`
- `--phone <phone>`
- `--username <username>`
- `--password <password>`
- `--first-name <first-name>`
- `--last-name <last-name>`
- `--external-id <external-id>`
- `--json`
- `-d, --data <json>`
- `--file <path>`

### `clerk users open`

Open a user's dashboard page in your browser, or print the URL with `--print`. With no positional `<user-id>`, prompts a search-as-you-type picker. Without a linked project (or matching app targeting), prompts the same application picker as `clerk users list`.

```sh
clerk users open
clerk users open user_2x9k
clerk users open user_2x9k --app app_123
clerk users open user_2x9k --instance prod
clerk users open user_2x9k --secret-key sk_test_123 --app app_123
clerk users open user_2x9k --print
```

In agent mode the user-id is required (no interactive picker) and output is a JSON object with `url`, `appId`, `appName`, `instanceId`, `instanceLabel`, `userId`, and `opened`. `--print` always wins and emits the plain URL on stdout.

`--secret-key` chooses the Backend API key used for user lookup. `users open` still requires an app target to resolve the dashboard URL, either from `--app`, a linked project, or the human-mode app picker. Use `--instance` when you want something other than the default development instance.

## API Endpoints

| Method | Endpoint    | Command(s)                                  |
| ------ | ----------- | ------------------------------------------- |
| `GET`  | `/v1/users` | `list`, `open` (when picking interactively) |
| `POST` | `/v1/users` | `create`                                    |

## Notes

- Human mode prints concise tables or summaries for reads and terse success summaries for mutations by default; agent mode defaults to JSON across the users command family.
- `--json` is the response-output flag across the users command family.
- `-d, --data` is the inline raw-BAPI-body flag for `create`; `--file` reads the same body from a file.
- `--dry-run` is available on mutating commands to preview the outgoing request.
