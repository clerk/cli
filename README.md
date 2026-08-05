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
  -h, --help           Display help for command

Commands:
  init             [options]                      Initialize Clerk in your project
  auth                                            Manage authentication
  link             [options]                      Link this project to a Clerk application
  unlink           [options]                      Unlink this project from its Clerk application
  whoami           [options]                      Show the current logged-in user and linked application
  open                                            Open Clerk resources in your browser
  apps                                            Manage your Clerk applications
  users            [options]                      Manage Clerk users
  impersonate|imp  [options] [user]               Impersonate a Clerk user
  env                                             Manage environment variables
  config                                          Manage instance configuration
  enable                                          Enable Clerk features on the linked instance
  disable                                         Disable Clerk features on the linked instance
  api              [options] [endpoint] [filter]  Make authenticated requests to the Clerk API
  doctor           [options]                      Check your project's Clerk integration health
  mcp                                             Manage the Clerk remote MCP server connection for AI editors and CLIs
  completion       [shell]                        Generate shell autocompletion script
  update           [options]                      Update the Clerk CLI to the latest version
  deploy                                          Deploy a Clerk application to production
  webhooks                                        Stream webhook events to a local handler and verify their signatures
  help             [command]                      Display help for command
  bird                                            Play Clerk Bird, a Flappy Bird game in your terminal
```

## Telemetry

The Clerk CLI collects anonymous usage telemetry (command name, flag names, duration,
outcome, and environment signals like OS, install method, and terminal). It never
collects command arguments, option values, file paths, or personal data. See
https://clerk.com/docs/telemetry for details.

Opt out by setting `CLERK_TELEMETRY_DISABLED=1` (or the standard `DO_NOT_TRACK=1`).
