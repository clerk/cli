# Doctor Command

Runs a series of diagnostic checks on your Clerk CLI setup and reports
the status of each check. The command is read-only and never modifies
any state (unless `--fix` is used).

## Usage

```sh
clerk doctor             # Run all checks
clerk doctor --verbose   # Show detailed output
clerk doctor --json      # Output results as JSON
clerk doctor --spotlight # Only show warnings and failures
clerk doctor --fix       # Offer to auto-fix issues
```

## Options

| Flag          | Description                                           |
| ------------- | ----------------------------------------------------- |
| `--verbose`   | Show detailed diagnostic info for each check          |
| `--json`      | Output results as machine-readable JSON               |
| `--spotlight` | Only show warnings and failures (hide passing checks) |
| `--fix`       | Offer to auto-fix issues with known remedies          |

## Checks

| Check                 | Category       | What it verifies                                                                                                                                                                                     |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication token  | Authentication | Credential store has a stored token                                                                                                                                                                  |
| Token validity        | Authentication | Token is still valid (calls `/oauth/userinfo`)                                                                                                                                                       |
| Project linkage       | Project        | Current directory is linked to a Clerk app                                                                                                                                                           |
| Linked application    | Project        | Linked application ID is accessible via the API                                                                                                                                                      |
| Instances             | Project        | Configured dev/prod instance IDs match the application's instances                                                                                                                                   |
| Environment variables | Environment    | .env.local or .env has Clerk keys                                                                                                                                                                    |
| CLI configuration     | Configuration  | CLI config file exists and parses                                                                                                                                                                    |
| Shell completion      | Configuration  | Shell autocompletion is installed for the detected shell                                                                                                                                             |
| MCP server            | Integration    | If a Clerk MCP entry is installed, every distinct configured server answers the `initialize` handshake; warns on an unreadable client config (skipped when nothing is installed; warns, never fails) |

### Accountless applications

The Authentication token, Token validity, and Project linkage checks resolve
the same accountless fallback the rest of the CLI uses (`lib/keyless-target.ts`):
a project with no account session and no linked profile, but a `sk_...` key
on disk (or in `CLERK_SECRET_KEY`/framework env var), is running on an
**unclaimed accountless application** — a legitimate, healthy state, not a broken
one.

- No token, accountless key present → **pass**, naming the instance. The claim
  hint depends on where the app came from: with a `.clerk/keyless.json`
  breadcrumb (left by `clerk init`) it says `clerk auth login` claims it;
  without one — an SDK-minted `.clerk/.tmp/keyless.json`, or a hand-copied
  `CLERK_SECRET_KEY` — it says to claim from the Clerk Dashboard instead,
  because `clerk auth login` only auto-claims apps `clerk init` created.
- Stored session expired, accountless key present → **warn** (not fail): the
  accountless key still works, logging in again is optional.
- Signed in (has account credentials) but this directory isn't linked, accountless
  key present → **warn**: the account could reach the fuller configuration by
  running `clerk link`, so that's called out unlike the fully unclaimed case.
- No token **and** no accountless key found anywhere → still **fail**. Accountless
  only changes the outcome when there's actually a secret key to fall back to.

The Linked application and Instances checks are account-only (the Platform
API application/instance-list concepts have no accountless equivalent), so they
continue to skip for a accountless project — the skip reason names the accountless
application instead of reading like a problem.

## Auto-Fix (`--fix`)

When `--fix` is passed in human mode, the command prompts to fix each
issue after all checks complete. After applying fixes, all checks are
re-run to verify the results.

`--fix` only works in human mode because the underlying fix actions are
interactive (`clerk auth login` opens a browser, `clerk link` shows a
picker). It is ignored in `--json` mode and agent mode.

Fixable issues:

| Issue                              | Fix action                          |
| ---------------------------------- | ----------------------------------- |
| Not logged in / expired token      | Log in with `clerk auth login`      |
| Not linked to an app / stale app   | Link project with `clerk link`      |
| Missing environment variables      | Pull env vars with `clerk env pull` |
| Missing or corrupt CLI config file | Log in with `clerk auth login`      |

Duplicate fix actions (e.g., multiple checks suggesting `clerk auth login`)
are deduplicated.

## Agent / CI Usage

AI agents and CI pipelines should use `--json` to get structured output:

```sh
clerk doctor --json              # Diagnose, output JSON
clerk doctor --json --spotlight  # JSON with only warnings/errors
```

Each result includes `name`, `status` (`pass` / `warn` / `fail`),
`message`, and optionally `detail` (extra diagnostic info), `remedy`
(a human-readable fix instruction), and `fix` (a label describing
the auto-fix action).

Agents cannot use `--fix` directly because the fix actions are interactive.
Instead, agents should read the `remedy` field from the JSON output and
orchestrate fixes themselves (e.g., ask the user to run `clerk auth login`,
or call `clerk link --app <id>` with a known app ID).

Exit code 1 signals one or more checks failed.

## Exit Codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| 0    | All checks passed (warnings are allowed) |
| 1    | One or more checks failed                |

## API Endpoints

| Method | Endpoint                            | Description                                                         |
| ------ | ----------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/oauth/userinfo`                   | Validates the stored auth token                                     |
| `GET`  | `/v1/platform/applications/{appId}` | Verifies the linked app and its instances exist                     |
| `GET`  | `/v1/instance`                      | Names the accountless application (best-effort, via its secret key) |
