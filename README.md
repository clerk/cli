# Clerk CLI

A command-line interface for managing your Clerk instances. This CLI provides tools for managing users, organizations, sessions, domains, Clerk Protect, and more.

## Installation

From Homebrew:

```bash

## while github repo is private, ensure you're authenticated with GitHub CLI:
gh auth status
gh auth setup-git

## new install:
brew tap clerk/gocli git@github.com:clerk/gocli.git && brew install clerk

## or to update:
brew update && brew upgrade clerk

```

Build from source:

```bash
go build -o clerk ./cmd/clerk
```

## Quick Start

### Interactive Setup

Run the setup wizard to configure your first profile:

```bash
clerk init
```

This will guide you through:
- Entering your Clerk Secret Key (find it in the [Clerk Dashboard](https://dashboard.clerk.com) → API Keys)
- Optionally creating a named profile

### Manual Setup

Alternatively, create a profile directly:

```bash
clerk config profile create default --api-key sk_live_xxxxx
```

### Verify Configuration

```bash
clerk whoami
```

### Start Using Commands

```bash
clerk users list
clerk protect rules list SIGN_IN
```

If you run a command without an API key configured, the CLI will prompt you to enter one in interactive terminals.

---

## Global Options

These options can be used with any command:

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Use a specific profile |
| `-o, --output <format>` | Output format: `table`, `json`, or `yaml` (default: `table`) |
| `--dotenv` | Use `CLERK_SECRET_KEY` from `.env` file (see [Project-Level Configuration](#project-level-configuration-env-files)) |
| `--debug` | Enable debug mode (outputs HTTP requests to stderr) |
| `-h, --help` | Display colorized help |

Help output is automatically colorized when running in an interactive terminal. You can control this behavior with environment variables:
- `NO_COLOR=1` - Disable colors
- `FORCE_COLOR=1` - Force colors even in non-interactive mode

```bash
# Output as JSON
clerk -o json protect rules list SIGN_IN

# Output as YAML
clerk --output yaml users get user_abc123

# Combine options
clerk --profile staging -o json protect rules list
```

---

## Command Shortcuts

### Prefix Matching

You can abbreviate commands as long as they're unambiguous:

```bash
clerk prot rul list SIGN_IN    # protect rules list
clerk conf prof li              # config profile list
clerk w                         # whoami
clerk us ls                     # users list
```

If a prefix matches multiple commands, an error is shown.

### Command Aliases

Create custom shortcuts for frequently used commands:

```bash
# Create aliases
clerk config alias add prl -- protect rules list
clerk config alias add pra protect rules add

# Use aliases
clerk prl SIGN_IN              # expands to: clerk protect rules list SIGN_IN
clerk pra SIGN_IN -g "block"   # expands to: clerk protect rules add SIGN_IN -g "block"
```

See [`clerk config alias`](#clerk-config-alias) for full documentation.

---

## Global Commands

### `clerk init`

Run the interactive setup wizard to configure the CLI. This is the recommended way to get started.

```bash
clerk init
```

The wizard will prompt you for:
- Clerk Secret Key
- Profile name (default: "default")

Note: This command requires an interactive terminal.

### `clerk whoami`

Display the currently active profile and how it was selected.

```bash
clerk whoami
# Active profile: production
#   (set via CLERK_PROFILE environment variable)
```

---

## Configuration

The CLI uses an INI-based configuration system where **profiles** can override **default settings**. Each profile can have its own API key, output format, debug mode, and other settings.

### Configuration Resolution

When resolving a setting value, the CLI checks in this order:
1. Command-line flag (e.g., `--output json`)
2. Environment variable (e.g., `CLERK_SECRET_KEY`)
3. `.env` file (for `clerk.key` only, when applicable — see below)
4. Active profile's value
5. Default value

### Project-Level Configuration (.env files)

The CLI can automatically detect and use a `CLERK_SECRET_KEY` from a `.env` file in your project directory. This is useful for development workflows where you want to use project-specific API keys without configuring global profiles.

#### How It Works

When you run a command without the `-p` flag, the CLI searches for a `.env` file starting from the current directory and walking up through parent directories. If found, it reads the `CLERK_SECRET_KEY` value.

```bash
# Example .env file in your project root
CLERK_SECRET_KEY=sk_test_xxxxx
```

#### Resolution Priority

The `.env` file is used as a **fallback** when no profile key is configured:

1. If your profile already has a `clerk.key` configured → profile key is used
2. If your profile has no key → `.env` file is used automatically

When a `.env` file exists but your profile has a key configured, the CLI warns you:

```
⚠ Found .env file at /path/to/project/.env but using profile key. Use --dotenv to use the .env file instead.
```

#### Using `--dotenv` Flag

Use the `--dotenv` flag to explicitly use the `.env` file, even when your profile has a key configured:

```bash
# Force using .env file instead of profile key
clerk users list --dotenv

# See which key would be used
clerk whoami --dotenv

# Check config resolution
clerk config list --dotenv
```

#### When `.env` Is NOT Used

The `.env` file is skipped in these cases:

- When `-p <profile>` flag is specified (explicit profile selection)
- When `CLERK_SECRET_KEY` environment variable is set (env var takes priority)
- When `--dotenv` is not specified and the active profile has a key configured

#### Example Workflow

```bash
# Project structure
my-app/
├── .env                    # Contains CLERK_SECRET_KEY=sk_test_project_key
└── src/

# In the project directory (no profile key configured)
cd my-app
clerk users list            # Uses sk_test_project_key from .env

# With a profile key configured
clerk config set clerk.key sk_test_profile_key
clerk users list            # Uses sk_test_profile_key (warns about .env)
clerk users list --dotenv   # Uses sk_test_project_key from .env

# Using explicit profile
clerk users list -p staging # Uses staging profile, ignores .env
```

#### Supported `.env` Format

The CLI supports standard `.env` file format:

```bash
# Comments are ignored
CLERK_SECRET_KEY=sk_test_xxxxx

# Quoted values are supported
CLERK_SECRET_KEY="sk_test_xxxxx"
CLERK_SECRET_KEY='sk_test_xxxxx'

# Spaces around = are allowed
CLERK_SECRET_KEY = sk_test_xxxxx
```

Only `CLERK_SECRET_KEY` is read from `.env` files. Other Clerk environment variables (like `CLERK_API_URL`) should be set via profiles or shell environment variables.

### Available Settings

| Setting | Description | Env Var |
|---------|-------------|---------|
| `clerk.key` | Clerk secret API key | `CLERK_SECRET_KEY` |
| `clerk.api.url` | Clerk API URL (default: `https://api.clerk.com`) | `CLERK_API_URL` |
| `output` | Default output format (`table`, `json`, `yaml`) | |
| `debug` | Enable debug mode (`true`, `false`) | `CLERK_CLI_DEBUG` |
| `ai.provider` | AI provider (`openai`, `anthropic`) | |
| `ai.openai.key` | OpenAI API key | `OPENAI_API_KEY` |
| `ai.openai.model` | OpenAI model (default: `gpt-4o`) | |
| `ai.anthropic.key` | Anthropic API key | `ANTHROPIC_API_KEY` |
| `ai.anthropic.model` | Anthropic model (default: `claude-sonnet-4-20250514`) | |
| `ai.mcp.config` | Path to MCP servers config file (default: `~/.config/clerk/cli/mcp.json`) | |

---

## Configuration Commands

### `clerk config set <key> <value> [options]`

Set a configuration value. Use `--profile` to set in a specific profile.

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Set value in a specific profile |
| `--type <type>` | Value type: `command` (executes shell command to get value) |

```bash
# Set default output format
clerk config set output json

# Set API key in a specific profile
clerk config set clerk.key sk_live_xxxxx --profile production

# Use a command to fetch the API key from a secrets manager
clerk config set clerk.key "op read 'op://Vault/Clerk/api-key'" --type=command --profile production
```

### `clerk config get <key> [options]`

Get a configuration value.

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Get value for a specific profile |
| `--resolve` | Execute command-type values to get the actual value |

```bash
clerk config get output
# json

clerk config get clerk.key --profile production
# ****xxxx

# For command-type values, use --resolve to execute
clerk config get clerk.key --profile production --resolve
# sk_live_xxxxx
```

### `clerk config unset <key> [options]`

Remove a configuration value.

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Unset from a specific profile |

```bash
clerk config unset output
clerk config unset debug --profile development
```

### `clerk config list [options]`

List all configuration settings and their current values.

| Option | Description |
|--------|-------------|
| `-p, --profile <name>` | Show resolved values for a specific profile |

```bash
clerk config list
# Profile: default
#
# KEY                VALUE                SOURCE
# clerk.key          sk_te****xxxx        profile
# clerk.api.url      https://api.clerk…   default
# output             table                default
# debug              (not set)            -
```

### `clerk config path`

Show the configuration file path.

```bash
clerk config path
# /Users/you/.config/clerk/cli/profiles
```

---

### `clerk config profile`

Manage CLI profiles. Profiles allow you to switch between different Clerk instances (development, staging, production) with different settings.

#### `clerk config profile list`

List all configured profiles.

```bash
clerk config profile list
#    NAME
# *  default
#    staging
#    production
```

#### `clerk config profile create <name> [options]`

Create a new profile.

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Clerk secret API key |
| `--api-url <url>` | Custom API URL |

```bash
# Basic usage
clerk config profile create production --api-key sk_live_xxxxx

# With custom API URL
clerk config profile create staging --api-key sk_test_xxxxx --api-url https://api.staging.clerk.com
```

#### `clerk config profile update <name>`

Update an existing profile. Use `clerk config set` with `--profile` to update individual settings.

```bash
clerk config set clerk.key sk_live_new_key --profile production
```

#### `clerk config profile delete <name>`

Delete a profile.

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk config profile delete staging
```

#### `clerk config profile use <name>`

Set the active profile.

```bash
clerk config profile use production
```

#### `clerk config profile show [name]`

Show profile details. If no name is provided, shows the active profile.

```bash
clerk config profile show production
# Profile: production
# clerk.key: ****xxxx
# clerk.api.url: https://api.clerk.com
```

#### `clerk config profile path`

Display the path to the profiles configuration file.

```bash
clerk config profile path
# /Users/you/.config/clerk/cli/profiles
```

---

### `clerk config alias`

Manage command aliases for creating shortcuts to frequently used commands.

#### `clerk config alias add <name> <command>`

Create a command alias. Arguments passed when using the alias are appended to the command.

```bash
clerk config alias add prl protect rules list
clerk config alias add pra protect rules add
clerk config alias add cpl config profile list
```

#### `clerk config alias remove <name>`

Remove a command alias. Also available as `clerk config alias rm`.

```bash
clerk config alias remove prl
clerk config alias rm pra
```

#### `clerk config alias list`

List all configured aliases. Also available as `clerk config alias ls`.

```bash
clerk config alias list
# NAME  COMMAND
# prl   protect rules list
# pra   protect rules add
```

#### `clerk config alias path`

Show the aliases file path.

```bash
clerk config alias path
# /Users/you/.config/clerk/cli/aliases.json
```

#### Using Aliases

When you use an alias, any additional arguments are appended:

```bash
# If prl = "protect rules list"
clerk prl SIGN_IN --limit 5
# Expands to: clerk protect rules list SIGN_IN --limit 5
```

#### Suggested Aliases

```bash
clerk config alias add prl protect rules list
clerk config alias add pra protect rules add
clerk config alias add prg protect rules get
clerk config alias add prd protect rules delete
clerk config alias add pre protect rules edit
clerk config alias add prr protect rules reorder
clerk config alias add prf protect rules flush
clerk config alias add ps protect schema show
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CLERK_PROFILE` | Profile name to use (overrides the default profile) |
| `CLERK_SECRET_KEY` | API key (overrides profile's API key) |
| `CLERK_API_URL` | API URL (overrides profile's API URL) |
| `CLERK_CLI_DEBUG` | Set to `1` or `true` to enable debug mode |
| `OPENAI_API_KEY` | OpenAI API key for AI-powered rule generation |
| `ANTHROPIC_API_KEY` | Anthropic API key for AI-powered rule generation |

### Profile Selection Priority

The CLI determines which profile to use in this order:

1. `--profile <name>` command-line flag
2. `CLERK_PROFILE` environment variable
3. Default profile from configuration file
4. Falls back to a profile named "default"

### Example Usage

```bash
# Use a specific profile for one command
clerk --profile staging protect rules list SIGN_IN

# Set profile via environment variable
export CLERK_PROFILE=production
clerk protect rules list SIGN_IN

# Override API key for CI/CD
CLERK_SECRET_KEY=${{ secrets.CLERK_KEY }} clerk protect rules list SIGN_IN
```

---

## Clerk Protect Commands

All protect subcommands accept the following option:

| Option | Description |
|--------|-------------|
| `--mcp-config <path>` | Path to MCP servers config file (overrides profile setting and default) |

### `clerk protect rules`

Manage Clerk Protect rules for blocking suspicious authentication attempts.

#### Rulesets

Rules are organized into rulesets based on the event type:

| Ruleset | Description |
|---------|-------------|
| `ALL` | Rules applied to all event types |
| `SIGN_IN` | Rules for sign-in authentication attempts |
| `SIGN_UP` | Rules for new user registrations |
| `SMS` | Rules for SMS verification requests |
| `EMAIL` | Rules for email verification requests |

#### `clerk protect rules list [ruleset] [options]`

List all rules in a ruleset. If no ruleset is specified, lists rules from all rulesets.

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum number of rules to return |
| `--after <id>` | Pagination cursor (rule ID to start after) |

```bash
clerk protect rules list SIGN_IN
```

#### `clerk protect rules get <ruleset> <ruleId>`

Get details of a specific rule.

```bash
clerk protect rules get SIGN_IN rule_abc123
```

#### `clerk protect rules edit <ruleset> <ruleId> [options]`

Open a rule's expression in your preferred editor (`$VISUAL` or `$EDITOR`).

| Option | Description |
|--------|-------------|
| `--description <text>` | Also update the rule description |

```bash
clerk protect rules edit SIGN_IN rule_abc123
```

Note: Set the `EDITOR` or `VISUAL` environment variable to use a specific editor (e.g., `export EDITOR=nano`). For GUI editors that detach, use a wait flag (e.g., `export EDITOR="code --wait"`).

#### `clerk protect rules add [ruleset] [options]`

Add a new rule. If ruleset or expression are not provided and the terminal is interactive, you will be prompted to enter them.

| Option | Description |
|--------|-------------|
| `--expression <expr>` | Rule expression (must evaluate to boolean) |
| `-g, --generate <desc>` | Generate expression from natural language using AI |
| `--action <action>` | Action when expression is true (default: `BLOCK`) |
| `--description <text>` | Human-readable description |
| `--before <id>` | Insert before this rule ID |
| `--after <id>` | Insert after this rule ID |
| `--index <n>` | Insert at specific index |

```bash
# With all options specified
clerk protect rules add SIGN_IN \
  --expression "ip.privacy.is_vpn == true" \
  --description "Block VPN users" \
  --action BLOCK

# Interactive mode (will prompt for ruleset, expression, and description)
clerk protect rules add

# Generate expression from natural language description
clerk protect rules add SIGN_IN --generate "block requests from datacenters"
clerk protect rules add SIGN_IN -g "when the bot score is greater than 50%"
```

#### `clerk protect rules delete <ruleset> <ruleId> [-f]`

Delete a specific rule.

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk protect rules delete SIGN_IN rule_abc123
```

#### `clerk protect rules flush <ruleset> [-f]`

Delete all rules in a ruleset.

```bash
clerk protect rules flush SIGN_IN --force
```

#### `clerk protect rules reorder <ruleset>`

Interactively reorder rules within a ruleset. Rules are evaluated in order from top to bottom.

```bash
clerk protect rules reorder SIGN_IN
```

Note: This command requires an interactive terminal.

---

### AI-Powered Rule Generation

The `--generate` (or `-g`) flag on `clerk protect rules add` uses AI to convert natural language descriptions into valid rule expressions.

#### Configuration

Configure an AI provider using settings, commands, or environment variables:

```bash
# Option 1: Using config settings (stores key in plain text)
clerk config set ai.provider openai
clerk config set ai.openai.key sk-...

# Option 2: Using a command to fetch from a secret manager (recommended)
clerk config set ai.provider openai
clerk config set ai.openai.key "op read 'op://Vault/OpenAI/api-key'" --type=command

# Or for Anthropic
clerk config set ai.provider anthropic
clerk config set ai.anthropic.key "vault kv get -field=api_key secret/anthropic" --type=command

# Option 3: Using environment variables
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

When using `--type=command`, the command is executed each time the API key is needed, ensuring you always have fresh credentials.

#### Usage

```bash
# Generate and create a rule
clerk protect rules add SIGN_IN --generate "block requests from datacenters"

# The CLI will:
# 1. Fetch the schema for the ruleset
# 2. Generate an expression using AI
# 3. Show you the generated expression
# 4. Ask for confirmation before creating
```

#### Example Descriptions

- "block VPN users"
- "requests from Russia or China"
- "when the IP is from a datacenter"
- "high bot scores above 70%"
- "non-US phone numbers with suspicious activity"
- "block if automation score exceeds 50%"

#### MCP Tool Servers

You can connect external tool servers using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) to give the AI access to live data during rule generation. This is useful for lookups that the AI can't do on its own, such as:

- Converting an ASN name (e.g., "Cloudflare") to its ASN number
- Looking up which ASN is announcing a specific IP address
- Querying domain name registration (WHOIS) data
- Resolving hostnames or checking IP reputation

##### Configuration

Create `~/.config/clerk/cli/mcp.json`:

```json
{
  "servers": {
    "asn-lookup": {
      "command": "npx",
      "args": ["-y", "@example/asn-mcp-server"]
    },
    "whois": {
      "command": "/usr/local/bin/whois-mcp-server",
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

Each server entry has:

| Field | Description |
|-------|-------------|
| `command` | The executable to run (required) |
| `args` | Command-line arguments (optional) |
| `env` | Additional environment variables (optional) |

Servers are started as subprocesses using the MCP stdio transport. The CLI discovers available tools from each server at startup and makes them available to the LLM during expression generation and modification.

To use a different config file, pass `--mcp-config` to any protect subcommand:

```bash
clerk protect rules add --generate "block VPNs" --mcp-config /path/to/mcp.json
```

You can also set it per profile:

```bash
clerk config set ai.mcp.config /path/to/custom/mcp.json --profile production
```

##### How It Works

When MCP servers are configured, the AI can call tools during rule generation:

```
$ clerk protect rules add SIGN_IN -g "block traffic from Cloudflare's ASN"
Loaded 3 tool(s) from MCP servers
Generating expression for: block traffic from Cloudflare's ASN

# The AI calls the asn-lookup tool to resolve "Cloudflare" → AS13335
# Then generates the expression using the resolved number

Generated expression:
  ip.asn.number == 13335

? Create rule with this expression? Yes
```

If no MCP servers are configured, the AI generates expressions using only the schema and its built-in knowledge — no tools are called. Servers that fail to start are skipped gracefully.

##### Debugging

Use `--debug` or `CLERK_CLI_DEBUG=1` to see MCP tool calls and results:

```bash
CLERK_CLI_DEBUG=1 clerk protect rules add SIGN_IN -g "block Cloudflare ASN"
# [DEBUG] MCP tool call: resolve_asn({"name":"Cloudflare"})
# [DEBUG] MCP tool result: {"asn":13335,"name":"Cloudflare, Inc.","country":"US"}
```

---

### `clerk protect schema`

View expression schemas for rule expressions.

#### `clerk protect schema show [eventType] [options]`

Show the detailed schema for an event type.

| Option | Description |
|--------|-------------|
| `--flat` | Show fields as flat dot-notation paths |

```bash
clerk protect schema show SIGN_IN
clerk protect schema show SIGN_IN --flat
```

#### `clerk protect schema list`

List all available event types and their top-level fields.

```bash
clerk protect schema list
```

#### `clerk protect schema type [names...]`

Show struct type details. If no type names are specified, lists all available types.

```bash
clerk protect schema type
clerk protect schema type ip geo
```

---

## User Management Commands

### `clerk users`

Manage Clerk users - list, create, update, delete, ban, lock, and more. Also available as `clerk user`.

#### `clerk users list [options]`

List all users with optional filtering and pagination.

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum number of users to return (default: 10) |
| `--offset <n>` | Number of users to skip for pagination |
| `--order-by <field>` | Sort field (prefix with `-` for desc, `+` for asc) |
| `--email <emails>` | Filter by email addresses (comma-separated) |
| `--phone <phones>` | Filter by phone numbers (comma-separated) |
| `--username <usernames>` | Filter by usernames (comma-separated) |
| `--external-id <ids>` | Filter by external IDs (comma-separated) |
| `--user-id <ids>` | Filter by user IDs (comma-separated) |
| `--organization-id <ids>` | Filter by organization membership (comma-separated) |
| `--query <text>` | Search across email, phone, username, name, user ID |
| `--last-active-since <timestamp>` | Filter users active since this Unix timestamp |

```bash
clerk users list
clerk users list --limit 50 --offset 100
clerk users list --query "john"
clerk users list --email john@example.com
clerk users list --order-by -last_active_at
```

#### `clerk users count [options]`

Get total user count with optional filtering.

| Option | Description |
|--------|-------------|
| `--email <email>` | Filter by email |
| `--phone <phone>` | Filter by phone |
| `--query <text>` | Search query |

```bash
clerk users count
clerk users count --query "example.com"
```

#### `clerk users get <userId>`

Get detailed information about a specific user.

```bash
clerk users get user_2abc123def456
```

#### `clerk users create [options]`

Create a new user.

| Option | Description |
|--------|-------------|
| `--email <emails>` | Email addresses (comma-separated) |
| `--phone <phones>` | Phone numbers (comma-separated) |
| `--username <username>` | Username |
| `--first-name <name>` | First name |
| `--last-name <name>` | Last name |
| `--password <password>` | Password |
| `--external-id <id>` | External ID |
| `--public-metadata <json>` | Public metadata (JSON) |
| `--private-metadata <json>` | Private metadata (JSON) |
| `--skip-password-checks` | Skip password complexity validation |
| `--skip-password-requirement` | Allow creating user without password |

```bash
clerk users create --email john@example.com --first-name John --last-name Doe
clerk users create --email john@example.com --password "securepassword123"
```

#### `clerk users update <userId> [options]`

Update an existing user.

| Option | Description |
|--------|-------------|
| `--first-name <name>` | First name |
| `--last-name <name>` | Last name |
| `--username <username>` | Username |
| `--password <password>` | New password |
| `--external-id <id>` | External ID |
| `--primary-email-id <id>` | Set primary email address by ID |
| `--primary-phone-id <id>` | Set primary phone number by ID |
| `--public-metadata <json>` | Public metadata (replaces existing) |
| `--private-metadata <json>` | Private metadata (replaces existing) |
| `--skip-password-checks` | Skip password complexity validation |
| `--sign-out-other-sessions` | Sign out all other sessions after password change |

```bash
clerk users update user_123 --first-name Jane --last-name Smith
clerk users update user_123 --password "newpassword123" --sign-out-other-sessions
```

#### `clerk users delete <userId> [-f]`

Delete a user permanently.

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk users delete user_123
clerk users delete user_123 --force
```

#### `clerk users ban <userId>`

Ban a user, revoking all sessions and preventing sign-in.

```bash
clerk users ban user_123
```

#### `clerk users unban <userId>`

Remove the ban from a user.

```bash
clerk users unban user_123
```

#### `clerk users lock <userId>`

Lock a user account temporarily.

```bash
clerk users lock user_123
```

#### `clerk users unlock <userId>`

Remove the lockout from a user account.

```bash
clerk users unlock user_123
```

#### `clerk users verify-password <userId> [options]`

Verify a user's password.

| Option | Description |
|--------|-------------|
| `--password <password>` | Password to verify (prompts if not provided) |

```bash
clerk users verify-password user_123 --password "testpassword"
clerk users verify-password user_123  # interactive prompt
```

---

## Organization Commands

### `clerk organizations`

Manage organizations, memberships, and invitations. Also available as `clerk orgs`.

#### `clerk organizations list [options]`

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum number to return |
| `--offset <n>` | Pagination offset |
| `--order-by <field>` | Sort field |
| `--query <text>` | Search by name or slug |
| `--include-members-count` | Include member counts |

```bash
clerk organizations list
clerk orgs list --query "acme" --include-members-count
```

#### `clerk organizations get <organizationId>`

Get organization details.

```bash
clerk organizations get org_abc123
```

#### `clerk organizations create [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Organization name (required) |
| `--slug <slug>` | URL-friendly identifier |
| `--created-by <userId>` | User ID of the creator |
| `--max-allowed-memberships <n>` | Maximum members allowed |
| `--public-metadata <json>` | Public metadata |
| `--private-metadata <json>` | Private metadata |

```bash
clerk organizations create --name "Acme Corp"
clerk orgs create --name "Acme Corp" --slug "acme" --max-allowed-memberships 50
```

#### `clerk organizations update <organizationId> [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Organization name |
| `--slug <slug>` | Slug |
| `--max-allowed-memberships <n>` | Max membership limit |
| `--public-metadata <json>` | Public metadata |
| `--private-metadata <json>` | Private metadata |

```bash
clerk organizations update org_abc123 --name "Acme Corporation"
```

#### `clerk organizations delete <organizationId> [-f]`

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk organizations delete org_abc123 --force
```

---

### `clerk organizations members`

#### `clerk organizations members list <organizationId> [options]`

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum members to return |
| `--offset <n>` | Pagination offset |
| `--role <roles>` | Filter by role(s) |

```bash
clerk orgs members list org_abc123
clerk orgs members list org_abc123 --role admin
```

#### `clerk organizations members add <organizationId> <userId> [options]`

| Option | Description |
|--------|-------------|
| `--role <role>` | Role to assign (required) |

```bash
clerk orgs members add org_abc123 user_xyz --role basic_member
```

#### `clerk organizations members update <organizationId> <memberId> [options]`

| Option | Description |
|--------|-------------|
| `--role <role>` | New role to assign |

```bash
clerk orgs members update org_abc123 mem_xyz --role admin
```

#### `clerk organizations members remove <organizationId> <memberId>`

```bash
clerk orgs members remove org_abc123 mem_xyz
```

---

### `clerk organizations invitations`

#### `clerk organizations invitations list <organizationId> [options]`

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum invitations to return |
| `--offset <n>` | Pagination offset |
| `--status <status>` | Filter by status: `pending`, `accepted`, `revoked` |

```bash
clerk orgs invitations list org_abc123 --status pending
```

#### `clerk organizations invitations create <organizationId> [options]`

| Option | Description |
|--------|-------------|
| `--email <email>` | Email address to invite (required) |
| `--role <role>` | Role to assign when accepted (required) |
| `--inviter-user-id <id>` | User ID of the inviter |
| `--redirect-url <url>` | URL to redirect to after accepting |

```bash
clerk orgs invitations create org_abc123 --email john@example.com --role basic_member
```

#### `clerk organizations invitations revoke <organizationId> <invitationId>`

```bash
clerk orgs invitations revoke org_abc123 inv_xyz
```

---

## Session Commands

### `clerk sessions`

Manage user sessions. Also available as `clerk session`.

#### `clerk sessions list [options]`

| Option | Description |
|--------|-------------|
| `--user-id <id>` | Filter by user ID |
| `--client-id <id>` | Filter by client ID |
| `--status <status>` | Filter by status |
| `--limit <n>` | Maximum sessions to return |
| `--offset <n>` | Pagination offset |

```bash
clerk sessions list --user-id user_2abc123
clerk sessions list --user-id user_2abc123 --status active
```

#### `clerk sessions get <sessionId>`

```bash
clerk sessions get sess_abc123
```

#### `clerk sessions revoke <sessionId>`

```bash
clerk sessions revoke sess_abc123
```

---

## API Keys Commands

### `clerk apikeys`

Manage API keys. Also available as `clerk api-keys`.

#### `clerk apikeys list [options]`

| Option | Description |
|--------|-------------|
| `--subject <id>` | Filter by user ID or organization ID |
| `--query <text>` | Search by name |
| `--limit <n>` | Maximum keys to return |
| `--offset <n>` | Pagination offset |

```bash
clerk apikeys list
clerk apikeys list --subject user_2abc123
```

#### `clerk apikeys get <apiKeyId>`

```bash
clerk apikeys get ak_abc123
```

#### `clerk apikeys create [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Name for the API key (required) |
| `--subject <id>` | User ID or organization ID (required) |
| `--description <text>` | Description |
| `--scopes <scopes>` | Comma-separated scopes |
| `--expires-in <seconds>` | Seconds until expiration |

```bash
clerk apikeys create --name "My API Key" --subject user_2abc123
```

#### `clerk apikeys revoke <apiKeyId> [-f]`

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk apikeys revoke ak_abc123
```

---

## Invitation Commands

### `clerk invitations`

Manage instance-level invitations. Also available as `clerk invite`.

#### `clerk invitations list [options]`

| Option | Description |
|--------|-------------|
| `--status <status>` | Filter by status: `pending`, `accepted`, `revoked`, `expired` |
| `--limit <n>` | Maximum invitations to return |
| `--offset <n>` | Pagination offset |

```bash
clerk invitations list
clerk invitations list --status pending
```

#### `clerk invitations create [options]`

| Option | Description |
|--------|-------------|
| `--email <email>` | Email address to invite (required) |
| `--redirect-url <url>` | URL to redirect to after accepting |
| `--expires-in-days <n>` | Days until expiration |
| `--no-notify` | Don't send the invitation email |
| `--ignore-existing` | Create even if invitation already exists |
| `--public-metadata <json>` | Public metadata |

```bash
clerk invitations create --email john@example.com
clerk invitations create --email john@example.com --no-notify --expires-in-days 7
```

#### `clerk invitations bulk-create [options]`

Create multiple invitations at once.

| Option | Description |
|--------|-------------|
| `--emails <emails>` | Comma-separated email addresses (required) |
| `--redirect-url <url>` | Redirect URL |
| `--expires-in-days <n>` | Days until expiration |
| `--no-notify` | Don't send invitation emails |

```bash
clerk invitations bulk-create --emails user1@example.com,user2@example.com,user3@example.com
```

#### `clerk invitations revoke <invitationId> [-f]`

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk invitations revoke inv_abc123
```

---

## Restrictions Commands

### `clerk restrictions`

Manage allowlist and blocklist restrictions for sign-ups.

#### `clerk restrictions list`

List all allowlist and blocklist identifiers.

```bash
clerk restrictions list
clerk restrictions ls
```

#### `clerk restrictions add <identifier> [options]`

Add an identifier to the allowlist or blocklist.

| Option | Description |
|--------|-------------|
| `--allow` | Add to allowlist (permits sign-up) |
| `--block` | Add to blocklist (prevents sign-up) |
| `--notify` | Send notification email (allowlist only) |

```bash
# Add to allowlist
clerk restrictions add john@example.com --allow
clerk restrictions add john@example.com --allow --notify

# Add to blocklist
clerk restrictions add spammer@example.com --block
clerk restrictions add "@spam-domain.com" --block
```

#### `clerk restrictions remove <id>`

Remove an identifier from the allowlist or blocklist by its ID. Also available as `clerk restrictions rm`.

```bash
clerk restrictions remove alid_abc123
clerk restrictions rm blid_abc123
```

---

## User Email Commands

### `clerk users emails`

Manage email addresses for users. Also available as `clerk users email`.

#### `clerk users emails list <userId>`

List all email addresses for a user.

```bash
clerk users emails list user_abc123
```

#### `clerk users emails get <emailAddressId>`

Get details of an email address.

```bash
clerk users emails get idn_abc123
```

#### `clerk users emails add <userId> [options]`

Add an email address to a user.

| Option | Description |
|--------|-------------|
| `--email <email>` | Email address (required) |
| `--verified` | Mark as verified |
| `--primary` | Set as primary email |

```bash
clerk users emails add user_abc123 --email john@example.com
clerk users emails add user_abc123 --email john@example.com --verified --primary
```

#### `clerk users emails update <emailAddressId> [options]`

Update an email address.

| Option | Description |
|--------|-------------|
| `--verified` | Mark as verified |
| `--primary` | Set as primary email |

```bash
clerk users emails update idn_abc123 --verified --primary
```

#### `clerk users emails remove <emailAddressId>`

Remove an email address.

```bash
clerk users emails remove idn_abc123
```

---

## User Phone Commands

### `clerk users phones`

Manage phone numbers for users. Also available as `clerk users phone`.

#### `clerk users phones list <userId>`

List all phone numbers for a user.

```bash
clerk users phones list user_abc123
```

#### `clerk users phones get <phoneNumberId>`

Get details of a phone number.

```bash
clerk users phones get idn_abc123
```

#### `clerk users phones add <userId> [options]`

Add a phone number to a user.

| Option | Description |
|--------|-------------|
| `--phone <number>` | Phone number in E.164 format (required) |
| `--verified` | Mark as verified |
| `--primary` | Set as primary phone number |

```bash
clerk users phones add user_abc123 --phone "+15551234567"
clerk users phones add user_abc123 --phone "+15551234567" --verified --primary
```

#### `clerk users phones update <phoneNumberId> [options]`

Update a phone number.

| Option | Description |
|--------|-------------|
| `--verified` | Mark as verified |
| `--primary` | Set as primary phone number |

```bash
clerk users phones update idn_abc123 --verified --primary
```

#### `clerk users phones remove <phoneNumberId>`

Remove a phone number.

```bash
clerk users phones remove idn_abc123
```

---

## Domain Commands

### `clerk domains`

Manage instance domains including satellite domains.

#### `clerk domains list`

```bash
clerk domains list
```

#### `clerk domains get <domainId>`

```bash
clerk domains get dom_abc123
```

#### `clerk domains add [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Domain name (required) |
| `--proxy-url <url>` | Proxy URL |

```bash
clerk domains add --name app.example.com
```

#### `clerk domains update <domainId> [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | New domain name |
| `--proxy-url <url>` | Proxy URL |

```bash
clerk domains update dom_abc123 --name new.example.com
```

#### `clerk domains delete <domainId> [-f]`

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk domains delete dom_abc123 --force
```

---

## JWT Templates Commands

### `clerk jwttemplates`

Manage JWT templates. Also available as `clerk jwt`.

#### `clerk jwttemplates list`

```bash
clerk jwttemplates list
```

#### `clerk jwttemplates get <templateId>`

```bash
clerk jwttemplates get jtmpl_abc123
```

#### `clerk jwttemplates create [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Template name (required) |
| `--claims <json>` | Claims as JSON object (required) |
| `--lifetime <seconds>` | Token lifetime in seconds |
| `--clock-skew <seconds>` | Allowed clock skew in seconds |
| `--signing-algorithm <alg>` | Signing algorithm (e.g., RS256, HS256) |
| `--signing-key <key>` | Signing private key |

```bash
clerk jwttemplates create \
  --name "Hasura" \
  --claims '{"https://hasura.io/jwt/claims": {"x-hasura-user-id": "{{user.id}}"}}'
```

#### `clerk jwttemplates update <templateId> [options]`

Same options as create.

```bash
clerk jwttemplates update jtmpl_abc123 --lifetime 7200
```

#### `clerk jwttemplates delete <templateId> [-f]`

| Option | Description |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

```bash
clerk jwttemplates delete jtmpl_abc123 --force
```

---

## JWKS Commands

### `clerk jwks get`

Retrieve JSON Web Key Sets for your Clerk instance.

```bash
clerk jwks get
clerk jwks get -o json
```

---

## Instance Commands

### `clerk instance`

Manage instance-level settings and restrictions.

#### `clerk instance get`

```bash
clerk instance get
```

#### `clerk instance update [options]`

| Option | Description |
|--------|-------------|
| `--test-mode` / `--no-test-mode` | Enable/disable test mode |
| `--hibp` / `--no-hibp` | Enable/disable HIBP password breach checking |
| `--support-email <email>` | Support email address |
| `--clerk-js-version <version>` | Clerk.js version |
| `--development-origin <origin>` | Development origin URL |
| `--allowed-origins <origins>` | Allowed origins (comma-separated) |
| `--url-based-session-syncing` / `--no-url-based-session-syncing` | URL-based session syncing |

```bash
clerk instance update --test-mode
clerk instance update --support-email support@example.com
```

### `clerk instance restrictions update [options]`

| Option | Description |
|--------|-------------|
| `--allowlist` / `--no-allowlist` | Enable/disable allowlist |
| `--blocklist` / `--no-blocklist` | Enable/disable blocklist |
| `--block-email-subaddresses` / `--no-block-email-subaddresses` | Block email subaddresses |
| `--block-disposable-emails` / `--no-block-disposable-emails` | Block disposable emails |

```bash
clerk instance restrictions update --allowlist --block-disposable-emails
```

---

## M2M Commands

### `clerk m2m`

Manage machine-to-machine authentication.

### `clerk m2m tokens`

#### `clerk m2m tokens list [options]`

| Option | Description |
|--------|-------------|
| `--machine-id <id>` | Filter by machine ID |
| `--limit <n>` | Maximum tokens to return |
| `--offset <n>` | Pagination offset |

```bash
clerk m2m tokens list --machine-id mch_abc123
```

#### `clerk m2m tokens create [options]`

| Option | Description |
|--------|-------------|
| `--machine-id <id>` | Machine ID (required) |
| `--scopes <scopes>` | Comma-separated scopes |
| `--expires-in <seconds>` | Seconds until expiration |

```bash
clerk m2m tokens create --machine-id mch_abc123 --scopes "read:users,write:users"
```

#### `clerk m2m tokens verify [options]`

| Option | Description |
|--------|-------------|
| `--token <token>` | Token to verify (required) |

```bash
clerk m2m tokens verify --token clerk_m2m_xxxxx
```

### `clerk m2m machines`

#### `clerk m2m machines list [options]`

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum machines to return |
| `--offset <n>` | Pagination offset |
| `--query <text>` | Search query |

```bash
clerk m2m machines list
clerk m2m machines list --query "backend"
```

#### `clerk m2m machines get <machineId>`

```bash
clerk m2m machines get mch_abc123
```

#### `clerk m2m machines create [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | Machine name (required) |
| `--scopes <scopes>` | Comma-separated scopes |

```bash
clerk m2m machines create --name "Backend Service"
```

#### `clerk m2m machines update <machineId> [options]`

| Option | Description |
|--------|-------------|
| `--name <name>` | New machine name |

```bash
clerk m2m machines update mch_abc123 --name "New Service Name"
```

#### `clerk m2m machines delete <machineId>`

```bash
clerk m2m machines delete mch_abc123
```

#### `clerk m2m machines get-secret <machineId>`

Retrieve the secret for a machine.

```bash
clerk m2m machines get-secret mch_abc123
```

#### `clerk m2m machines add-scope <machineId> [options]`

| Option | Description |
|--------|-------------|
| `--scope <scope>` | Scope to add (required) |

```bash
clerk m2m machines add-scope mch_abc123 --scope "read:users"
```

---

## Configuration Files

The CLI stores configuration in `~/.config/clerk/cli/`:

| File | Purpose |
|------|---------|
| `profiles` | Configuration profiles and settings (INI format) |
| `aliases.json` | Command aliases (JSON format) |
| `mcp.json` | MCP tool server configuration (JSON format, optional) |

### Profiles File

Configuration is stored in `~/.config/clerk/cli/profiles` using INI format:

```ini
[default]
profile = production

[profile default]
clerk.key = sk_test_xxxxx
output = table

[profile production]
clerk.key = sk_live_xxxxx
output = json

[profile staging]
clerk.key = sk_test_yyyyy
clerk.api.url = https://api.staging.clerk.com

[profile vault]
clerk.key = !op read 'op://Vault/Clerk/api-key'
output = table
```

**Structure:**
- `[default]` section: Global settings and active profile
- `[profile <name>]` sections: Profile-specific settings
- Lines starting with `#` or `;` are comments
- Values prefixed with `!` are treated as shell commands

### Aliases File

Aliases are stored in `~/.config/clerk/cli/aliases.json`:

```json
{
  "prl": "protect rules list",
  "pra": "protect rules add"
}
```

### Using Commands to Fetch Secrets

Instead of storing API keys directly, use `--type=command` with `config set` to store a command that fetches a value dynamically. The command string is stored with a `!` prefix in the profiles file and executed via your shell each time the value is needed.

```bash
clerk config set clerk.key "op read 'op://Vault/Clerk/api-key'" --type=command --profile production
```

#### Example: 1Password CLI

```bash
clerk config set clerk.key "op read 'op://Vault/Clerk Production/api-key'" --type=command --profile production
```

#### Example: AWS Secrets Manager

```bash
clerk config set clerk.key "aws secretsmanager get-secret-value --secret-id clerk/api-key --query SecretString --output text" --type=command --profile production
```

#### Example: HashiCorp Vault

```bash
clerk config set clerk.key "vault kv get -field=api_key secret/clerk/production" --type=command --profile production
```

---

## Contributing

### Project Structure

```
cmd/clerk/
  main.go                    # Entry point
internal/
  api/
    client.go                # Base HTTP client with retry logic
    users.go                 # Users API
    organizations.go         # Organizations API
    sessions.go              # Sessions API
    apikeys.go               # API Keys API
    invitations.go           # Invitations API
    restrictions.go          # Restrictions API (allowlist/blocklist)
    emails.go                # Email Addresses API
    phones.go                # Phone Numbers API
    domains.go               # Domains API
    jwttemplates.go          # JWT Templates API
    instance.go              # Instance API
    jwks.go                  # JWKS API
    m2m.go                   # M2M API (tokens + machines)
    protect.go               # Protect Rules & Schema API
  cmd/
    root.go                  # Root command, global flags, prefix matching
    args.go                  # Argument validation helpers
    prefix.go                # Prefix matching logic
    init.go                  # Init/setup wizard
    whoami.go                # Whoami command
    config.go                # Config, profile, and alias commands
    users.go                 # Users commands
    organizations.go         # Organizations commands
    sessions.go              # Sessions commands
    apikeys.go               # API Keys commands
    invitations.go           # Invitations commands
    restrictions.go          # Restrictions (allowlist/blocklist) commands
    emails.go                # User email addresses commands (under users)
    phones.go                # User phone numbers commands (under users)
    domains.go               # Domains commands
    jwttemplates.go          # JWT templates commands
    instance.go              # Instance commands
    jwks.go                  # JWKS commands
    m2m.go                   # M2M commands
    protect.go               # Protect commands
  config/
    config.go                # Configuration management (INI format)
    aliases.go               # Command aliases (JSON format)
  output/
    format.go                # Output formatting (table/json/yaml)
    colors.go                # Colorized output helpers
  ai/
    ai.go                    # AI provider abstraction
    openai.go                # OpenAI provider
    anthropic.go             # Anthropic provider
    mcp.go                   # MCP client (JSON-RPC over stdio)
    mcp_config.go            # MCP server configuration loader
    tools.go                 # Tool manager (routes calls to MCP servers)
```

### Architecture

The CLI is built with [Cobra](https://github.com/spf13/cobra) and follows a modular architecture:

- **cmd/** - Command definitions using Cobra. Each file defines a command group with its subcommands and flags.
- **api/** - HTTP client layer. Each file implements API calls for a specific resource type. The base client handles authentication, retries with exponential backoff, and debug logging.
- **config/** - Configuration management using INI-based profiles with support for command-type values that execute shell commands.
- **output/** - Output formatting supporting table, JSON, and YAML formats with colorized terminal output.
- **ai/** - Pluggable AI provider integration for natural language rule generation.

### Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/spf13/cobra` | CLI framework |
| `github.com/AlecAivazis/survey/v2` | Interactive prompts |
| `github.com/fatih/color` | Terminal colors |
| `github.com/olekukonov/tablewriter` | Table output |
| `gopkg.in/yaml.v3` | YAML output |
| `golang.org/x/term` | Terminal detection |

### Development

```bash
# Build
go build -o clerk ./cmd/clerk

# Run
./clerk --help

# Test commands
./clerk config path
./clerk config set clerk.key "test_key" --profile test
./clerk whoami
./clerk users list --output json
```
