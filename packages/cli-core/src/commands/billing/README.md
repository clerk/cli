# clerk billing (enable/disable)

Toggle Clerk billing for organizations and/or users on the linked instance.
The handlers are wired to top-level `clerk enable billing` and `clerk disable
billing` commands.

**Requires a linked application.** Unlike `clerk enable/disable orgs`, these
commands cannot run on the folder's secret key alone: billing settings exist only
in the account-level config document, and Clerk's Backend API exposes no billing
resource an instance secret key could reach. In a folder that isn't linked but
holds a secret key, both commands exit with an `auth_required` error that gives
the step for what the folder holds (from `lib/unlinked-folder.ts`), e.g.
`clerk link`, which claims an app `clerk init` created or finds plain keys' app by
its publishable key. The error calls the app unclaimed only for an app in no
account yet (an init app, or an SDK app whose claim link works).

For arbitrary billing config edits (plans, trials, payment-method requirements)
use `clerk config patch --json '{"billing":{...}}'` until a dedicated
`clerk billing settings` command lands.

## Usage

```
clerk enable billing [--for <targets>] [options]
clerk disable billing [--for <targets>] [options]
```

`<targets>` is `orgs` and/or `users`, accepted as space-separated, comma-separated,
or repeated `--for` flags (matching `clerk config pull --keys`). The singular
forms `org` and `user` are still accepted as aliases for backward compatibility.
When omitted, the command targets both:

```sh
clerk enable billing --for orgs users
clerk enable billing --for orgs,users
clerk enable billing --for orgs --for users
clerk enable billing                     # defaults to both
```

## Options

| Flag              | Description                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| `--for <targets>` | Targets (`orgs` and/or `users`), separated by spaces or commas. Defaults to both. |
| `--app <id>`      | Target a specific application                                                     |
| `--instance <id>` | Target a specific instance (dev, prod)                                            |
| `--yes`           | Skip the confirmation prompt                                                      |
| `--dry-run`       | Preview the patch without applying it                                             |
| `--no-skills`     | Skip the post-enable `clerk-billing` agent skill install (enable only)            |

## Agent skill

After a successful `enable billing`, the command offers to install the upstream `clerk-billing` agent skill from [`clerk/skills`](https://github.com/clerk/skills). `clerk init` doesn't bundle this one as a default — billing is opt-in — so this is the natural moment to surface it.

- **Human mode**: prompts `Install the` `clerk-billing` `agent skill?` defaulting to yes. Decline returns silently.
- **Agent mode (recognized agent run or no TTY) or `--yes`**: installs non-interactively (`-y -g`).
- **`--no-skills`**: skips the install entirely.
- **`--dry-run`**: skips the install (no real side-effects in dry-run).

The install runs via the user's package runner (`bunx`, `pnpm dlx`, `yarn dlx`, or `npx`), matching the `clerk init` flow.

## Cascade behavior

- `enable billing --for orgs` (or `orgs,users`, or no `--for`) **also** sets
  `organization_settings.enabled = true`. Billing for organizations requires
  organizations enabled, so this saves a separate command. The cascade is
  idempotent — if organizations are already on, the diff is empty for that
  field.
- `disable billing` **never** touches `organization_settings`. To disable
  organizations themselves, run `clerk disable orgs` separately.

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                                   |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config for diff before mutation                 |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch `billing.*` (with `?dry_run=true` when `--dry-run` set) |
