# Unlink Command

Removes the association between the current project directory and its linked Clerk application.

## Usage

```sh
clerk unlink
clerk unlink --yes
```

## Options

| Flag | Description |
|---|---|
| `--yes` | Skip the confirmation prompt |

## Behavior

1. Resolves the current profile by walking up from the working directory
2. If no profile is found, exits with an error
3. Prompts for confirmation (unless `--yes` is passed)
4. Removes the profile entry from `~/.clerk/config.json`

## Agent Mode

In agent mode, outputs a structured prompt describing the unlink steps instead of running the interactive flow.
