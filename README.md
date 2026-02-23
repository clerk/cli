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
  deploy [options]     Deploy your Clerk application (hidden)

clerk init
  --prompt             Output a prompt for an AI agent to integrate Clerk

clerk config pull
  --instance <id>      Instance to target (dev, prod, or a full instance ID)
  --output <file>      Write config to a file instead of stdout

clerk deploy
  --debug              Show debug output
```
