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
  -v, --version        Output the version number
  --input-json <json>  Pass command options as a JSON string, @file.json, or -
                       for stdin
  --mode <mode>        Force interaction mode (human or agent). Defaults to
                       auto-detect based on TTY.
  --verbose            Show detailed output (enables debug messages)
  --quiet              Suppress non-essential output (info, warnings, spinners)
  --no-color           Disable ANSI color output (also respects the NO_COLOR env
                       var)
  -h, --help           Display help for command

Commands:
  init        [options]                      Initialize Clerk in your project
  auth                                       Manage authentication
  link        [options]                      Link this project to a Clerk application
  unlink      [options]                      Unlink this project from its Clerk application
  whoami      [options]                      Show the current logged-in user and linked application
  open                                       Open Clerk resources in your browser
  apps                                       Manage your Clerk applications
  users       [options]                      Manage Clerk users
  env                                        Manage environment variables
  config                                     Manage instance configuration
  enable                                     Enable Clerk features on the linked instance
  disable                                    Disable Clerk features on the linked instance
  api         [options] [endpoint] [filter]  Make authenticated requests to the Clerk API
  doctor      [options]                      Check your project's Clerk integration health
  schema      [options]                      Print the full CLI command tree as JSON (for agents and tooling)
  completion  [shell]                        Generate shell autocompletion script
  update      [options]                      Update the Clerk CLI to the latest version
  deploy                                     Deploy a Clerk application to production
  help        [command]                      Display help for command

Examples:
  $ clerk init                            Initialize Clerk in this project
  $ clerk auth login                      Authenticate via browser OAuth
  $ clerk apps list --json                List applications as JSON (agent-pipeable)
  $ clerk users list --json | jq '.data'  Pipe user list to jq
  $ clerk --mode agent api /users         Force agent mode for non-interactive use

Environment:
  CLERK_SECRET_KEY       Backend API secret key for the linked instance
                         (sk_test_… / sk_live_…)
  CLERK_MODE             Force interaction mode: human or agent (default: TTY
                         auto-detect)
  CLERK_CONFIG_DIR       Override the directory for stored credentials and
                         config
  CLERK_UPDATE_CHANNEL   Release channel for `clerk update` (e.g. latest,
                         canary)
  CLERK_NO_UPDATE_CHECK  Set to any value to disable the post-command update
                         notification

Next:
  $ clerk auth login           Authenticate (or set CLERK_SECRET_KEY for headless use)
  $ clerk init                 Set up Clerk in this project
  $ clerk doctor               Check that everything is wired up

Documentation:
  https://clerk.com/docs/cli
  https://github.com/clerk/cli

Give AI agents better Clerk context: install the Clerk skills
  $ clerk skill install
```
