# clerk status

Show the active instance, git-branch binding, and app for the current worktree.

`clerk status` shows the persisted active instance for this worktree; an exported `CLERK_SECRET_KEY` overrides it for commands that use a secret key.

The active instance is validated against the application's live instance list. The active label uses the env-qualified glyph form: the development root renders `● development ⎇ main`, a fork renders `● development ⎇ feature-auth`, and production renders `● production`. Only `main` is annotated, as `(default branch)`; forks and production get none because the glyph already conveys branch-ness. A non-enabled app's nameless dev root renders `● development`. `status --json` adds an additive `branch_name` alongside the raw `environment_type`. When the pointed-at instance no longer exists (for example, the branch was deleted from another checkout), the line renders as `<label> · instance no longer exists` with a warning that names the fix (`clerk switch`) and notes that `.env.local` still holds the stale keys. When the pointer was set on a different git branch than the current one, a drift warning names both branches and suggests `clerk switch` to re-point.

If the instance check fails (offline, API error), the command still succeeds and renders the local view without the existence annotation; `--json` reports `exists: null` in that case.

## Usage

    clerk status
    clerk status --json

## Options

- `--json` Output as JSON. The `active` object carries `instance_id`, `label`, `environment_type`, and `exists` (`true`/`false`, or `null` when the check could not run).

## Clerk API endpoints

- `GET /v1/platform/applications/{appId}`: validate that the active instance still exists (degrades gracefully when unreachable). Everything else reads the user-level Clerk config and local git state.
