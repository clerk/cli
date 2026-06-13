# clerk branch

Manage Clerk instance branches. Branches are development instances forked from an existing instance, enabling isolated configuration experiments without affecting production or the primary development environment.

## Subcommands

### `clerk branch create --name <name> [--from <instance>] [--app <app_id>]`

Forks an existing instance into a new named branch. By default clones from the `production` instance.

Options:

- `--name <name>` (required) — Name for the new branch
- `--from <instance>` — Source instance to clone from (`production`, `development`, or a literal instance ID). Defaults to `production`.
- `--app <app_id>` — Target application ID (overrides linked project)

Platform API: `POST /v1/platform/applications/{appId}/instances`

Agent mode output:

```json
{
  "status": "created",
  "branch_name": "feature-auth",
  "instance_id": "ins_abc123",
  "parent_instance_id": "ins_prod456"
}
```

### `clerk branch list [--app <app_id>]`

Lists all branches for the linked or specified application. Only instances with a `branch_name` are shown.

Options:

- `--app <app_id>` — Target application ID (overrides linked project)

Platform API: `GET /v1/platform/applications/{appId}`

Human output: one line per branch, tab-separated `branch_name\tinstance_id`.

Agent mode output:

```json
{
  "branches": [
    {
      "branch_name": "feature-auth",
      "instance_id": "ins_abc123",
      "parent_instance_id": "ins_dev456"
    }
  ]
}
```

### `clerk branch delete <name> [--app <app_id>]`

Deletes a named branch instance. The branch is looked up by name from the application's instance list.

Options:

- `<name>` (positional, required) — Name of the branch to delete
- `--app <app_id>` — Target application ID (overrides linked project)

Platform API:

1. `GET /v1/platform/applications/{appId}` — resolve branch name to instance ID
2. `DELETE /v1/platform/applications/{appId}/instances/{instanceId}` — delete the instance

Agent mode output:

```json
{
  "status": "deleted",
  "branch_name": "feature-auth",
  "instance_id": "ins_abc123"
}
```

### `clerk branch diff <name> [--against <instance>] [--app <app_id>]`

Shows a configuration diff between a branch and another instance (defaults to `production`).

Options:

- `<name>` (positional, required) — Name of the branch to diff
- `--against <instance>` — Instance to compare against (`production`, `development`, or a literal instance ID). Defaults to `production`.
- `--app <app_id>` — Target application ID (overrides linked project)

Platform API:

1. `GET /v1/platform/applications/{appId}/instances/{branchInstanceId}/config`
2. `GET /v1/platform/applications/{appId}/instances/{parentInstanceId}/config`

Output: a human-readable diff of changed leaf values, grouped by top-level config key. No agent-mode JSON — the diff is always rendered as text.
