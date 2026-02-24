# Init Command

Initializes Clerk in a project by authenticating the user and linking a Clerk application.

## Usage

```sh
clerk init
clerk init --prompt
```

## Options

| Flag | Description |
|---|---|
| `--prompt` | Output an AI agent prompt for integrating Clerk instead of running the interactive flow |

## Flow

1. Authenticates the user via `clerk auth login` (see [auth/README.md](../auth/README.md) for APIs)
2. Links the project to a Clerk application via `clerk link` (see [link/README.md](../link/README.md) for APIs)

## API Endpoints

See [auth/README.md](../auth/README.md) and [link/README.md](../link/README.md) for the API endpoints used by each step.
