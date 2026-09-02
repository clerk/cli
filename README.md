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
browser login. With no `--app` and no linked project, `clerk init` creates an
unclaimed development application, writes local development keys, and stores a
claim breadcrumb for a later `clerk auth login`. Frameworks without accountless
support need an authenticated app target before keys can be pulled: pass
`--app <id>`, use a linked project, or run `npx -y clerk@latest init --login`
in an interactive terminal to log in and link one.

What `clerk init` changes:

- Installs missing Clerk SDK packages in npm-based projects.
- Creates or updates supported framework files, such as provider wiring,
  middleware or proxy files, and sign-in/sign-up routes.
- Writes Clerk keys to the selected env file when a real or accountless app is
  available.
- In accountless mode, writes `.clerk/keyless.json` and adds `.clerk/` to
  `.gitignore`.
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
  --mode <mode>        Force interaction mode (human or agent). Defaults to
                       auto-detect based on TTY.
  -v, --version        Output the version number
  --verbose            Show detailed output (enables debug messages)

Commands:
  api              [options] [endpoint] [filter]  Call any Clerk API endpoint (200+; `clerk api ls` to browse)
  apps                                            Manage your Clerk applications
  auth                                            Manage authentication
  completion       [shell]                        Generate shell autocompletion script
  config                                          Manage instance configuration
  deploy                                          Deploy a Clerk application to production
  disable                                         Disable Clerk features on the linked instance
  doctor           [options]                      Check your project's Clerk integration health
  enable                                          Enable Clerk features on the linked instance
  env                                             Manage environment variables
  help             [command]                      Display help for command
  impersonate|imp  [options] [user]               Impersonate a Clerk user
  init             [options]                      Initialize Clerk in your project
  link             [options]                      Link this project to a Clerk application
  mcp                                             Manage the Clerk remote MCP server connection for AI editors and CLIs
  open                                            Open Clerk resources in your browser
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
environment signals (OS, install method, terminal), a random machine identifier — and
your workspace and app IDs when a project is linked. It never collects command
arguments, option values, file paths, or personal data. The first run only shows a
disclosure notice and sends nothing (CI environments send from the first run), and
`clerk --verbose` prints every event before it is sent. Shell completion (`clerk
completion <shell>` and the `__complete` helper behind Tab) sends nothing at all.
See https://clerk.com/docs/telemetry for details.

Opt out with `clerk telemetry disable`, or by setting `CLERK_TELEMETRY_DISABLED=1`
(the standard `DO_NOT_TRACK=1` also works). `clerk telemetry status` shows the
effective state and why.
