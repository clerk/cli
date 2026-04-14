# Skill Command

Manages the bundled `clerk-cli` agent skill. The skill is embedded in the CLI binary at compile time via text imports from `skills/clerk-cli/`, so it always matches the version of the CLI in use.

## Subcommands

### `clerk skill install`

Installs the bundled `clerk-cli` skill for any locally detected AI agents (Claude Code, Cursor, etc.). The actual agent detection and scope selection is delegated to the external [`skills`](https://www.npmjs.com/package/skills) CLI, which is invoked via the preferred package runner on PATH (`bunx`, `pnpm dlx`, `yarn dlx`, or `npx`).

Interactive mode hands off entirely to the `skills` CLI picker. Non-interactive mode (`-y`, agent mode, or no TTY) passes `-y -g` so the skills CLI runs unattended against global scope with auto-detected agents.

This command is delegated to by `clerk init` as part of its post-scaffold agent skills step; running it standalone is useful when adding the skill to an existing project that was set up before the skill was bundled, or when reinstalling after upgrading the CLI.

## Usage

```sh
clerk skill install
clerk skill install -y
clerk skill install --pm bun
```

## Options

| Option           | Description                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-y, --yes`      | Skip prompts; auto-select the preferred package runner and pass `-y -g` to the `skills` CLI                                 |
| `--pm <manager>` | Package manager hint for runner detection (`bun`, `pnpm`, `yarn`, `npm`). Defaults to lockfile detection in the current dir |

## Clerk API endpoints

None. This command does not make any Clerk API calls; it only spawns the external `skills` CLI against a staged copy of the bundled skill.
