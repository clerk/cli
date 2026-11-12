# clerk

The Clerk command-line interface.

## Add Clerk to an app

```sh
npx -y clerk@latest init
```

`clerk init` is the setup path for developers and coding agents. It detects the
framework, installs the matching Clerk SDK for npm-based projects when it is
missing, and scaffolds the Clerk wiring it can safely generate.

For accountless-capable frameworks (Next.js, Astro, Nuxt, TanStack Start, and
React Router), unauthenticated agent runs can start without a Clerk account or
browser login. With no `--app` and no linked project, a first `clerk init` run
creates an unclaimed development application, writes local development keys, and
stores a claim breadcrumb for a later `clerk auth login`. Later runs keep an
existing unclaimed application instead of replacing it, unless you pass
`--fresh`. Frameworks without accountless
support need an authenticated app target before keys can be pulled: pass
`--app <id>`, use a linked project, or run `npx -y clerk@latest init --login`
in an interactive terminal to log in and link one.

What `clerk init` changes:

- Installs missing Clerk SDK packages in npm-based projects.
- Creates or updates supported framework files, such as provider wiring,
  middleware or proxy files, and sign-in/sign-up routes.
- Writes Clerk keys to an env file when a real or accountless app is available.
- When it creates a new accountless application, writes `.clerk/keyless.json`
  and adds `.clerk/` to `.gitignore`.
- In npm-based projects, offers to install Clerk agent skills; agent mode runs
  that step non-interactively unless `--no-skills` is passed.

After setup, run `clerk doctor` to verify the integration:

```sh
npx -y clerk@latest doctor
```

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
  -h, --help           Display help for command
  --input-json <json>  Pass command options as a JSON string, @file.json, or -
                       for stdin
  --mode <mode>        Force interaction mode (human or agent). Also settable
                       via the CLERK_MODE environment variable. Defaults to
                       agent when run by a known AI agent or without a TTY.
  -v, --version        Output the version number
  --verbose            Show detailed output (enables debug messages)

Commands:
  api              [options] [endpoint] [filter]  Call any Clerk API endpoint (200+; `clerk api ls` to browse)
  apps                                            Manage your Clerk applications
  auth                                            Manage authentication
  completion       [shell]                        Generate shell autocompletion script
  config                                          Manage instance configuration
  deploy           [options]                      Deploy a Clerk application to production
  disable                                         Disable Clerk features on the linked instance
  doctor           [options]                      Check your project's Clerk integration health
  enable                                          Enable Clerk features on the linked instance
  env                                             Manage environment variables
  feedback         [options]                      Report a wrong result, a confusing error, a missing capability or a needed improvement to Clerk
  help             [command]                      Display help for command
  impersonate|imp  [options] [user]               Impersonate a Clerk user
  init             [options]                      Initialize Clerk in your project
  link             [options]                      Link this project to a Clerk application
  mcp                                             Manage the Clerk remote MCP server connection for AI editors and CLIs
  migrate                                         Migrate users into Clerk from another auth platform or another Clerk instance
  open                                            Open Clerk resources in your browser
  security                                        Audit an instance against Clerk's security recommendations
  telemetry                                       Control CLI usage telemetry (status, disable, enable)
  unlink           [options]                      Unlink this project from its Clerk application
  update           [options]                      Update the Clerk CLI to the latest version
  users            [options]                      Manage Clerk users
  webhooks                                        Stream webhook events to a local handler and verify their signatures
  whoami           [options]                      Show the current logged-in user and linked application
  bird                                            Play Clerk Bird, a Flappy Bird game in your terminal
```

## Telemetry

The Clerk CLI collects usage telemetry: command name, flag names, duration, outcome,
environment signals (OS, install method, terminal), a random machine identifier, the
platform a migration's users come from, and the workspace, app, and instance IDs of the
Clerk app a command acts on or the project is linked to. It doesn't collect raw command
arguments, option values, file paths, or personal data, with two exceptions. `clerk migrate`
reports its source as a built-in platform name or `custom`, and the IDs it acts on can come
from `--app` and `--instance`. `clerk feedback` sends the text you choose to send, and
scrubs it on a best-effort basis for common secret formats, home-directory paths, and email
addresses before it leaves your machine;
`clerk feedback --dry-run` shows exactly what would be sent. The first run only shows a
disclosure notice and sends nothing (CI environments send from the first run), except
`clerk feedback`, which shows the notice and then sends the report you asked it to send
and the run's usage event. `clerk --verbose` prints every event before it is sent. Shell
completion (`clerk completion <shell>` and the `__complete` helper behind Tab) sends
nothing at all. See https://clerk.com/docs/telemetry for details.

Feedback reports are stored in Clerk's internal telemetry warehouse next to usage
events, readable by Clerk staff with warehouse access. The CLI cannot delete one. To have
a report removed, contact Clerk support at https://clerk.com/contact/support with its
report id (printed after sending).

Opt out with `clerk telemetry disable`, or by setting `CLERK_TELEMETRY_DISABLED=1`
(the standard `DO_NOT_TRACK=1` also works). `clerk telemetry status` shows the
effective state and why. Opting out also blocks `clerk feedback`, which then prints the
GitHub issues URL instead.
