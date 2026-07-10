# clerk switch

Top-level alias of [`clerk branch switch`](../branch/README.md#clerk-branch-switch-target-options). Sets the _active instance_ for the current git worktree so other commands (`env pull`, `config`, `users`, etc.) target it without repeating `--instance`/`--branch` on every invocation.

Both `clerk switch` and `clerk branch switch` are wired to the same handler (`branchSwitch` in `../branch/switch.ts`); this directory only registers the shorter top-level spelling.

## Usage

```sh
# Switch to a branch (auto-pulls .env)
clerk switch agent/pr-42

# Switch to dev / prod
clerk switch dev
clerk switch prod --yes   # production requires confirmation (--yes skips it; required in agent mode)

# Fork the development instance into a new branch and switch to it
clerk switch -c agent/pr-99

# Toggle back to the previously active instance
clerk switch -

# Target without persisting the pointer
clerk switch prod --detach --yes
```

See [`../branch/README.md`](../branch/README.md#clerk-branch-switch-target-options) for the full option reference, JSON output shape, and Platform API calls (this command makes none directly: it delegates entirely to `branchSwitch`).
