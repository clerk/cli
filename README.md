# clerk

The Clerk command-line interface.

```
Usage: clerk [options] [command]

Clerk CLI

Options:
  -V, --version                      output the version number
  --mode <mode>                      Force interaction mode (human or agent).
                                     Defaults to auto-detect based on TTY.
  --verbose                          Show detailed error output
  -h, --help                         display help for command

Commands:
  init                               Initialize Clerk in your project
  auth                               Manage authentication
    login|signup       Log in to your Clerk account
    logout|signout     Log out of your Clerk account
  link [options]                     Link this project to a Clerk application
  unlink [options]                   Unlink this project from its Clerk
                                     application
  whoami                             Show the current logged-in user
  env                                Manage environment variables
    pull [options]     Pull environment variables from Clerk to .env.local
  config                             Manage instance configuration
    pull [options]     Pull instance configuration from Clerk
    schema [options]   Pull instance config schema from Clerk
    patch [options]    Partially update instance configuration (PATCH)
    put [options]      Replace entire instance configuration (PUT)
  api [options] [endpoint] [filter]  Make authenticated requests to the Clerk
                                     API
    ls [filter]        List available API endpoints
    (no args)          Interactive request builder (TTY only)
  doctor [options]                   Check your project's Clerk integration
                                     health
  deploy [options]     Deploy your Clerk application (hidden)
  help [command]                     display help for command

clerk init
  --prompt             Output a prompt for an AI agent to integrate Clerk

clerk link
  --app <id>           Application ID to link (skips interactive picker)

clerk unlink
  --yes                Skip confirmation prompt

clerk config pull
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write config to a file instead of stdout

clerk config schema
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write schema to a file instead of stdout
  --keys <keys...>     Config keys to retrieve schema for

clerk config patch
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Read config JSON from a file
  --json <string>      Pass config JSON inline
  --dry-run            Show what would be sent without making the API call
  --yes                Skip confirmation prompts

clerk config put
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Read config JSON from a file
  --json <string>      Pass config JSON inline
  --dry-run            Show what would be sent without making the API call
  --yes                Skip confirmation prompts

clerk env pull
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --file <path>        Target env file (default: auto-detect)

clerk api [endpoint] [filter]
  -X, --method <method>  HTTP method (default: GET, or POST if body provided)
  -d, --data <json>      JSON request body
  --file <path>          Read request body from a file
  --include              Show response headers
  --secret-key <key>     Override the secret key
  --instance <id>        Instance to target (dev, prod, or instance ID)
  --platform             Use Platform API instead of Backend API
  --dry-run              Show the request without executing it
  --yes                  Skip confirmation for mutating requests

clerk api ls [filter]    List available API endpoints
clerk api                Interactive request builder (TTY only)

clerk doctor
  --verbose            Show detailed output for each check
  --json               Output results as JSON
  --spotlight           Only show warnings and failures
  --fix                Attempt to auto-fix issues

clerk deploy
  --debug              Show debug output
```

## Open Questions

- How do we keep types in sync with PLAPI?
