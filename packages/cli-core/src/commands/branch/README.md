# clerk branch

Manage Clerk instance branches. Branches are development instances forked from the application's development instance.

## Subcommands

### `clerk branch create --name <name> [--app <app_id>]`

Forks the development instance into a new named branch. Every branch's parent is the permanent development root; production instances are never forked.

Options:

- `--name <name>` (required): Name for the new branch
- `--app <app_id>`: Target application ID (overrides linked project)
- `--json`: Output as JSON (also emitted automatically in agent mode)

Platform API: `POST /v1/platform/applications/{appId}/instances`

JSON output (`--json` or agent mode):

```json
{
  "status": "created",
  "branch_name": "feature-auth",
  "instance_id": "ins_abc123",
  "parent_instance_id": "ins_dev456"
}
```

### `clerk branch list [--app <app_id>]`

Lists all branches for the linked or specified application. Only instances with a `branch_name` are shown.

Options:

- `--app <app_id>`: Target application ID (overrides linked project)
- `--json`: Output as JSON (also emitted automatically in agent mode)

Platform API: `GET /v1/platform/applications/{appId}`

Human output: this is a pure branch view. Production has no branch identity and never appears. Rows are written to stderr under one shared column header (`BRANCH`, `INSTANCE ID`, `CREATED`). `main` (the null-parent branch) is pinned at the top as the default branch with no tree prefix; its forks follow as one flat box-drawing tree (`├` / `└`, the last fork closing with `└`) reading as forks of it, matching the `clerk switch` branch stage. `CREATED` is the branch instance's age rendered relative to now (e.g. `3d ago`). The active instance (per `clerk switch` / `clerk branch switch`), when it belongs to this app, is marked with a leading `●` in git style. On an app where branching is not enabled the dev root is nameless, so no branch rows exist and the output is just a `No branches yet.` note. For scripting, use `--json`: it prints a single `branches` list to stdout (`main` first, then its forks) plus the active instance in the `active_instance_id` field.

JSON output (`--json` or agent mode):

```json
{
  "branches": [
    {
      "branch_name": "main",
      "instance_id": "ins_dev456",
      "parent_instance_id": null,
      "publishable_key": "pk_test_...",
      "created_at": 1769000000000
    },
    {
      "branch_name": "feature-auth",
      "instance_id": "ins_abc123",
      "parent_instance_id": "ins_dev456",
      "publishable_key": "pk_test_...",
      "created_at": 1770000000000
    }
  ],
  "active_instance_id": "ins_abc123",
  "active_instance_missing": false
}
```

`main` is the branch whose `parent_instance_id` is null; its forks point at `main`'s instance. Each branch carries its `publishable_key` so bootstrap flows (fork a branch, hand the frontend its key) need no second API call; `secret_key` is always stripped. `active_instance_missing` is `true` when the persisted active pointer references an instance that is no longer in the application (deleted from another checkout); the human output prints a warning naming the stale pointer and suggesting `clerk switch` in that case.

### `clerk branch delete <name> [--app <app_id>] [--yes]`

Deletes a named branch instance. The branch is looked up by name from the application's instance list. This permanently removes the instance, so the command asks for confirmation in human mode; the prompt states the blast radius ("Permanently delete <name> and its instance? Users and settings on it are lost.") and defaults to No. Pass `--yes` to skip the prompt. In agent mode there is no prompt, so `--yes` is required. Refuses to delete the branch that is the active instance for the current worktree; switch away first with `clerk switch`.

Human output renders as a `Deleting branch · <name>` frame matching the other branch commands: the confirmation and the resolved `Deleted <name> (<instance_id>)` step render inside it, and declining the confirmation closes the frame as paused.

Options:

- `<name>` (positional, required): Name of the branch to delete
- `--app <app_id>`: Target application ID (overrides linked project)
- `--yes`: Skip the confirmation prompt (required in agent mode)
- `--json`: Output as JSON (also emitted automatically in agent mode)

Platform API:

1. `GET /v1/platform/applications/{appId}`: resolve branch name to instance ID
2. `DELETE /v1/platform/applications/{appId}/instances/{instanceId}`: delete the instance

JSON output (`--json` or agent mode):

```json
{
  "status": "deleted",
  "branch_name": "feature-auth",
  "instance_id": "ins_abc123"
}
```

### `clerk branch switch [target] [options]`

Sets the _active instance_ for the current git worktree, persisted in the CLI config file keyed by the worktree root. Once set, other commands (`env pull`, `config`, `users`, etc.) resolve their target instance from this pointer instead of falling back to `development`. Also available as the top-level alias `clerk switch` (see [`../switch/README.md`](../switch/README.md)).

**State & precedence:** The persisted active instance only applies to the linked-project workflow (no explicit `--app`). When you pass `--app` to target an application explicitly, commands act on that app directly and do not consult the worktree's active instance, even if one is set. An ambient `CLERK_SECRET_KEY` in the environment overrides the persisted active instance for commands that resolve a secret key, since key-based auth is resolved before the active-instance pointer is consulted. When that ambient key matches the `CLERK_SECRET_KEY` stored in the project's env file (the file `clerk switch` keeps in sync, commonly exported into the shell by dotenv tooling), output attributes it to the active instance: the `· on <instance>` echo still appears and stale-instance hints still fire. A mismatching ambient key (for example after `switch --no-pull`, or a key exported for CI) is treated as an anonymous env key, exactly as before.

Arguments:

- `[target]`: `dev` | `main` | `prod` | a branch name | a raw instance ID | `-` (toggle to the previously active instance). `dev` and `main` both resolve to the development root (two lenses, one instance). Omit the target to open the two-stage interactive selector (human mode) or print the current pointer (agent mode). Stage 1 picks the environment (`Development` / `Production`); stage 2 picks the branch (`main` + its forks as a box-drawing tree). Any single-option stage is skipped: with no production instance stage 1 is skipped and the flow goes straight to the branch stage; when `main` is the only branch, choosing `Development` resolves to it immediately; production never reaches the branch stage. In the branch stage the active instance is tagged `(current)` and preselected so the cursor opens on it. CLI arguments (`dev` | `prod` | a branch name | an instance ID) bypass the stages entirely.

Options:

- `-c, --create <name>`: Fork the development instance into a new branch, then switch to it
- `--app <app_id>`: Target application ID (overrides linked project)
- `--no-pull`: Skip syncing `.env` after switching (by default, switching to a non-production instance runs `env pull` automatically)
- `--detach`: Resolve and use the target for this invocation only; don't persist the active pointer
- `--yes`: Skip the production confirmation (required in agent mode; in human mode the prompt is shown unless this flag is passed)
- `--json`: Output as JSON (also emitted automatically in agent mode)

Human output renders as a single `Switching · <app>` frame: the fork (with `--create`) and the `.env` sync each appear as one resolved step. Fork messages use the bare parent branch name (`Forked main → feature-auth`), while the active-instance label uses the env-qualified glyph form, so the closing line reads `● development ⎇ feature-auth is now active (was development ⎇ main)`. Switching to production replaces the sync step with a note that `.env.local` was left untouched.

Platform API:

Plain switch (no `--create`):

1. `GET /v1/platform/applications/{appId}`: resolve the target instance

Switch with `--create` forks a new branch, so it issues two GETs plus a POST:

1. `GET /v1/platform/applications/{appId}`: resolve the fork parent (always the development root)
2. `POST /v1/platform/applications/{appId}/instances`: fork the new branch instance
3. `GET /v1/platform/applications/{appId}`: refetch to locate the created instance (falls back to the POST response if it is not yet present)

Switching to production always requires confirmation (`--yes` in agent mode, an interactive prompt in human mode unless `--yes` is passed) and never auto-pulls `.env`: run `clerk env pull --instance prod` explicitly if you need prod keys locally.

JSON output (`--json` or agent mode):

```json
{
  "status": "switched",
  "instance_id": "ins_abc123",
  "branch_name": "feature-auth",
  "environment_type": "development",
  "persisted": true,
  "env_pulled": true
}
```

Omitting `[target]` in agent mode prints the current pointer without switching, using the same instance fields as the `switched` shape. `persisted` is `false` when no pointer is set for the worktree, and `exists` is `false` when the pointer references an instance that no longer exists in the application (`null` when there is no pointer to check):

```json
{
  "status": "current",
  "instance_id": "ins_abc123",
  "branch_name": "feature-auth",
  "environment_type": "development",
  "persisted": true,
  "exists": true
}
```
