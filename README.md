# clerk

The Clerk command-line interface.

## Installation

### Homebrew (macOS / Linux)

```sh
brew install clerk/stable/clerk
```

### npm

```sh
npm install -g clerk
```

## Usage

```
Usage: clerk [options] [command]

Clerk CLI

Options:
  -v, --version  Output the version number
  --mode <mode>  Force interaction mode (human or agent). Defaults to
                 auto-detect based on TTY.
  --verbose      Show detailed output (enables debug messages)
  -h, --help     Display help for command

Commands:
  init        [options]                      Initialize Clerk in your project
  auth                                       Manage authentication
    login|signup                             Log in to your Clerk account
    logout|signout                           Log out of your Clerk account
  link        [options]                      Link this project to a Clerk application
  unlink      [options]                      Unlink this project from its Clerk application
  whoami                                     Show the current logged-in user
  open                                       Open Clerk resources in your browser
    dashboard [options] [subpath]            Open the linked app's dashboard
  apps                                       Manage your Clerk applications
    list      [options]                      List your Clerk applications
    create    [options] <name>               Create a new Clerk application
  config                                     Manage instance configuration
    pull      [options]                      Pull instance configuration from Clerk
    schema    [options]                      Pull instance config schema from Clerk
    patch     [options]                      Partially update instance configuration (PATCH)
    put       [options]                      Replace entire instance configuration (PUT)
  orgs|organizations                         Manage Clerk Organizations
    enable    [options]                      Enable organizations on the linked instance
    disable   [options]                      Disable organizations on the linked instance
  billing                                    Manage billing and subscription plans
    enable    [options]                      Enable billing on the linked instance
    disable   [options]                      Disable billing on the linked instance
    plans                                    Manage subscription plans
      create  [options] <slug>              Create a subscription plan
      list    [options]                      List subscription plans
      update  [options] <slug>              Update a subscription plan
      remove  [options] <slug>              Remove a subscription plan
  env                                        Manage environment variables
    pull      [options]                      Pull environment variables from Clerk to .env.local
  api         [options] [endpoint] [filter]  Make authenticated requests to the Clerk API
    ls [filter]                              List available API endpoints
    (no args)                                Interactive request builder (TTY only)
  doctor      [options]                      Check your project's Clerk integration health
  skill                                      Manage the bundled Clerk CLI agent skill
    install   [options]                      Install the bundled clerk agent skill
  switch-env  [environment]                  Switch the active Clerk CLI environment
  completion  [shell]                        Generate shell autocompletion script
  update      [options]                      Update the Clerk CLI to the latest version

Give AI agents better Clerk context: install the Clerk skills
  $ clerk skill install

clerk init
  --framework <name>     Framework to set up (skips auto-detection)
  --pm <manager>         Package manager to use (skips prompt/auto-detection)
  --name <project-name>  Project name for --starter (skips prompt)
  --app <id>             Application ID to link (skips interactive picker)
  --starter              Bootstrap a new project from a starter template
  --prompt               Output a prompt for an AI agent to integrate Clerk
  --yes                  Skip confirmation prompts
  --no-skills            Skip the optional agent skills install prompt
  Examples:
    $ clerk init                                      Auto-detect framework and set up Clerk
    $ clerk init --framework next                     Set up for Next.js (skips detection)
    $ clerk init --app app_123                        Link to a specific Clerk application
    $ clerk init --starter                            Create a new project with Clerk
    $ clerk init --starter --framework next --pm bun  Bootstrap with Bun
    $ clerk init --prompt                             Output a setup prompt for an AI agent
    $ clerk init -y                                   Skip all confirmation prompts
    $ clerk init --no-skills                          Skip the agent skills install prompt

clerk auth login         Log in via browser (OAuth)
clerk auth logout        Remove stored credentials

clerk link
  --app <id>           Application ID to link (skips interactive picker)
  Examples:
    $ clerk link                       Pick an app interactively
    $ clerk link --app app_abc123      Link directly by application ID

clerk unlink
  --yes                Skip confirmation prompt
  Examples:
    $ clerk unlink                     Unlink with confirmation prompt
    $ clerk unlink --yes               Skip confirmation

clerk whoami             Show your email address

clerk open [subpath]
  --print              Print the URL without opening the browser
  Examples:
    $ clerk open                       Open the linked app's dashboard
    $ clerk open users                 Open the users page
    $ clerk open api-keys              Open the API keys page
    $ clerk open --print               Print the dashboard URL

clerk config pull
  --app <id>           Application ID to target (works from any directory)
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write config to a file instead of stdout
  Examples:
    $ clerk config pull                          Print dev config to stdout
    $ clerk config pull --instance prod          Pull production config
    $ clerk config pull --output config.json     Save config to a file

clerk config schema
  --app <id>           Application ID to target (works from any directory)
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write schema to a file instead of stdout
  --keys <keys...>     Config keys to retrieve schema for
  Examples:
    $ clerk config schema                          Print full config schema
    $ clerk config schema --keys social_login      Schema for specific keys
    $ clerk config schema --output schema.json     Save schema to a file

clerk config patch
  --app <id>           Application ID to target (works from any directory)
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Read config JSON from a file
  --json <string>      Pass config JSON inline
  --dry-run            Show what would be sent without making the API call
  --yes                Skip confirmation prompts
  Examples:
    $ clerk config patch --file config.json                Apply partial update from file
    $ clerk config patch --json '{"key":"value"}'          Inline JSON patch
    $ clerk config patch --file config.json --dry-run      Preview without applying
    $ clerk config patch --instance prod --file config.json  Patch production config

clerk config put
  --app <id>           Application ID to target (works from any directory)
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Read config JSON from a file
  --json <string>      Pass config JSON inline
  --dry-run            Show what would be sent without making the API call
  --yes                Skip confirmation prompts
  Examples:
    $ clerk config put --file config.json                  Replace entire config from file
    $ clerk config put --file config.json --dry-run        Preview the replacement
    $ clerk config put --instance prod --file config.json  Replace production config
    $ clerk config put --file config.json --yes            Skip confirmation prompt

clerk orgs enable
  --force-selection    Force organization selection on login
  --auto-create        Auto-create an organization for new users
  --max-members <n>    Maximum members per organization
  --domains            Enable verified domains
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)
  Examples:
    $ clerk orgs enable                                    Enable organizations
    $ clerk orgs enable --force-selection                  Enable and force org selection
    $ clerk orgs enable --auto-create --max-members 10     Enable with auto-creation and member limit

clerk orgs disable
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)

clerk billing enable
  --for <org|user>     (required) Billing target type
  --require-payment-method  Require payment method for free trials
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)
  Examples:
    $ clerk billing enable --for org             Enable org billing
    $ clerk billing enable --for user            Enable user billing

clerk billing disable
  --for <org|user>     (required) Billing target type
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)

clerk billing plans create <slug>
  --name <name>        Override display name (default: title-cased slug)
  --amount <cents>     (required) Monthly price in cents
  --payer <org|user>   Who pays
  --currency <code>    Currency code (default: usd)
  --description <text> Plan description
  --trial-days <n>     Free trial length in days
  --annual-amount <cents>  Monthly equivalent when billed annually, in cents
  --hidden             Hide plan from end users
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)
  Examples:
    $ clerk billing plans create pro --amount 1999 --payer org
    $ clerk billing plans create enterprise --name "Enterprise Plus" --amount 9999 --payer org --trial-days 14

clerk billing plans list
  --json               Output as JSON
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)

clerk billing plans update <slug>
  --name <name>        Update display name
  --amount <cents>     Update monthly price
  --hidden             Hide plan from end users
  --visible            Show plan to end users
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)
  Examples:
    $ clerk billing plans update pro --amount 2999
    $ clerk billing plans update pro --hidden

clerk billing plans remove <slug>
  --app <id>           Application ID to target
  --instance <id>      Instance to target (dev, prod, or instance ID)

clerk env pull
  --app <id>           Application ID to target (works from any directory)
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Target env file (default: auto-detect)
  Examples:
    $ clerk env pull                             Pull dev keys to .env.local
    $ clerk env pull --instance prod             Pull production keys
    $ clerk env pull --file .env                 Write to a specific file
    $ clerk env pull --app app_abc123            Target a specific application

clerk api [endpoint] [filter]
  -X, --method <method>  HTTP method (default: GET, or POST if body provided)
  -d, --data <json>      JSON request body
  --file <path>          Read request body from a file
  --include              Show response headers
  --app <id>             Application ID to target when resolving keys
  --secret-key <key>     Override the secret key
  --instance <id>        Instance to target (dev, prod, or instance ID)
  --platform             Use Platform API instead of Backend API
  --dry-run              Show the request without executing it
  --yes                  Skip confirmation for mutating requests
  Examples:
    $ clerk api ls                                   List all available endpoints
    $ clerk api ls users                             List endpoints matching "users"
    $ clerk api /users                               GET /v1/users
    $ clerk api /users -d '{"first_name":"Alice"}'   POST with a JSON body

clerk api ls [filter]    List available API endpoints
clerk api                Interactive request builder (TTY only)

clerk apps list
  --json               Output as JSON

clerk apps create <name>
  --json               Output as JSON
  Examples:
    $ clerk apps create "My App"           Create a new application
    $ clerk apps create "My App" --json    Output as JSON

clerk doctor
  --verbose            Show detailed output for each check
  --json               Output results as JSON
  --spotlight           Only show warnings and failures
  --fix                Attempt to auto-fix issues
  Examples:
    $ clerk doctor                     Run all health checks
    $ clerk doctor --verbose           Show detailed output for each check
    $ clerk doctor --json              Output results as machine-readable JSON
    $ clerk doctor --fix               Auto-fix detected issues
    $ clerk doctor --spotlight         Only show warnings and failures

clerk skill install
  -y, --yes            Skip prompts and run the `skills` CLI unattended
  --pm <manager>       Package manager hint for runner detection
  Examples:
    $ clerk skill install              Install with an interactive runner picker
    $ clerk skill install -y           Install unattended
    $ clerk skill install --pm bun     Force bunx as the runner

clerk completion <shell>
  shell: bash, zsh, fish, powershell

clerk update
  --channel <tag>      Release channel to update to (e.g. latest, canary)
  -y, --yes            Skip confirmation prompt
  --all                Update every clerk install found on PATH, not just the first
  Examples:
    $ clerk update                       Update to the latest stable release
    $ clerk update --channel canary      Update to the latest canary release
    $ clerk update --yes                 Update without confirmation prompt
    $ clerk update --all                 Update every clerk install on PATH
```
