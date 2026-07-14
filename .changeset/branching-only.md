---
"clerk": minor
---

Add development instance branching to the CLI.

- `clerk branch create --name <name>` forks the development instance into a named branch. Run it with no arguments to be prompted for the branch name and offered to switch. `--switch` (`-s`) activates the new branch for the current worktree in one step.
- `clerk branch list`, `clerk branch delete <name>`, and `clerk branch switch <target>` manage branches. `switch` sets the active instance for the worktree, `switch -c` forks and switches together, and `switch -` toggles back to the previous instance, all through a two-stage selector.
- `clerk enable branches` and `clerk disable branches` gate branching per application. Enabling names the development root `main`; disabling is refused while live branches exist.
- `--branch <name>` targets a specific branch on instance-aware commands.
- Branch names are validated against git branch rules (letters, numbers, and `.` `_` `-` `/`, no spaces) and reserved names (main, dev, prod, development, production) are rejected, in both `clerk branch create` and `clerk switch --create`.
