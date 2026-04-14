# @clerk/cli

The Clerk command-line interface.

## Installation

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
  --verbose      Show detailed error output
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
  env                                        Manage environment variables
    pull      [options]                      Pull environment variables from Clerk to .env.local
  api         [options] [endpoint] [filter]  Make authenticated requests to the Clerk API
    ls [filter]                              List available API endpoints
    (no args)                                Interactive request builder (TTY only)
  doctor      [options]                      Check your project's Clerk integration health
  switch-env  [environment]                  Switch the active Clerk CLI environment
  completion  [shell]                        Generate shell autocompletion script
  deploy      [options]                      Deploy your Clerk application (hidden)

clerk init
  --framework <name>   Framework to set up (skips auto-detection)
  --app <id>           Link to a specific Clerk application by ID
  --starter            Bootstrap a new project from a starter template
  --prompt             Output a prompt for an AI agent to integrate Clerk
  --yes                Skip confirmation prompts
  --no-skills          Skip the optional agent skills install prompt
  Examples:
    $ clerk init                       Auto-detect framework and set up Clerk
    $ clerk init --framework next      Set up for Next.js (skips detection)
    $ clerk init --app app_123         Link to a specific Clerk application
    $ clerk init --starter             Create a new project with Clerk
    $ clerk init --prompt              Output a setup prompt for an AI agent
    $ clerk init -y                    Skip all confirmation prompts
    $ clerk init --no-skills           Skip the agent skills install prompt

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

clerk completion <shell>
  shell: bash, zsh, fish, powershell

clerk deploy
  --debug              Show debug output
```

## Open Questions

- How do we keep types in sync with PLAPI?
