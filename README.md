# @clerk/cli

The Clerk command-line interface.

```
Usage: clerk [options] [command]

Clerk CLI

Options:
  -V, --version        Display version
  --mode <mode>        Force interaction mode (human or agent).
                       Defaults to auto-detect based on TTY.
  -h, --help           Display help for command

Commands:
  init [options]       Initialize Clerk in your project
  auth                 Manage authentication
    login              Log in to your Clerk account
    logout             Log out of your Clerk account
  whoami               Show the current logged-in user
  config               Manage instance configuration
    pull [options]     Pull instance configuration from Clerk
    patch [options]    Partially update instance configuration (PATCH)
    put [options]      Replace entire instance configuration (PUT)
  env                  Manage environment variables
    pull [options]     Pull environment variables from Clerk to .env.local
  api [options] [endpoint] [filter]  Make authenticated requests to the Clerk API
    ls [filter]        List available API endpoints
    (no args)          Interactive request builder (TTY only)
  deploy [options]     Deploy your Clerk application (hidden)

clerk init
  --prompt             Output a prompt for an AI agent to integrate Clerk

clerk config pull
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write config to a file instead of stdout

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

clerk deploy
  --debug              Show debug output
```

## Open Questions

- How do we keep types in sync with PLAPI?
