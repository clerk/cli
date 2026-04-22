# Unlink Command

Removes the association between the current project directory and its linked Clerk application.

## Usage

```sh
clerk unlink
clerk unlink --yes
```

## Options

| Flag    | Description                  |
| ------- | ---------------------------- |
| `--yes` | Skip the confirmation prompt |

## Behavior

1. Resolves the current profile by checking the normalized remote URL, then git-common-dir, then walking up from the working directory
2. If no profile is found, exits with an error
3. Prompts for confirmation (unless `--yes` is passed)
4. Removes the profile entry from `~/.clerk/config.json`

## Agent Mode

In agent mode, `clerk unlink` requires `--yes`. With `--yes`, it removes the
link without prompting. Without `--yes`, it exits with a usage error instead of
showing an interactive confirmation.
