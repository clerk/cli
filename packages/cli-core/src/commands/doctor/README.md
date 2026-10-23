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

| Flag                           | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `--verbose`                    | Show detailed diagnostic info for each check                     |
| `--json`                       | Output results as machine-readable JSON                          |
| `--spotlight`                  | Only show warnings and failures (hide passing checks)            |
| `--fix`                        | Offer to auto-fix issues with known remedies                     |
| `--xcode-project <path>`       | Xcode project or workspace to check; also selects the iOS checks |
| `--xcode-target <name-or-id>`  | Xcode app target to check                                        |
| `--xcode-configuration <name>` | Xcode build configuration to check                               |

## Checks

| Check                 | Category       | What it verifies                                                                                                                                                                                     |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account credentials   | Authentication | Credential store has a session or a Platform API key is configured                                                                                                                                   |
| Token validity        | Authentication | OAuth access is verified through `/oauth/userinfo` or an account-scoped application-list fallback; Platform API-key access uses the same read-only application-list request                          |
| Project linkage       | Project        | Current directory is linked to a Clerk app                                                                                                                                                           |
| Linked application    | Project        | Linked application ID is accessible via the API                                                                                                                                                      |
| Instances             | Project        | Configured dev/prod instance IDs match the application's instances                                                                                                                                   |
| Environment variables | Environment    | The first env file the app loads that names a Clerk key (else the first that exists) has both keys                                                                                                   |
| CLI configuration     | Configuration  | CLI config file exists and parses                                                                                                                                                                    |
| Shell completion      | Configuration  | Shell autocompletion is installed for the detected shell                                                                                                                                             |
| MCP server            | Integration    | If a Clerk MCP entry is installed, every distinct configured server answers the `initialize` handshake; warns on an unreadable client config (skipped when nothing is installed; warns, never fails) |

### Accountless applications

The Authentication token, Token validity, and Project linkage checks resolve
the same accountless fallback the rest of the CLI uses (`lib/keyless-target.ts`):
a project with no account session and no linked profile, but a `sk_...` key
on disk (or in `CLERK_SECRET_KEY`/framework env var), runs on that key's app —
a legitimate, healthy state, not a broken one.

What the Authentication token and Project linkage checks say about it comes
from `lib/unlinked-folder.ts`, so `doctor` gives the same step as every other
command for what the folder holds. Statuses and fix labels don't depend on it.

- No token, a secret key present → **pass**, with the step in the message
  (`detail` only shows under `--verbose`):
  - **An init token** (`.clerk/keyless.json`, left by `clerk init` run signed
    out) **or only an SDK keyless file with a working claim link**
    (`.clerk/.tmp/keyless.json`): it names the **unclaimed accountless
    application** and its instance. A person is
    told to run `clerk link`, which claims an init app, or links an SDK app
    (opening its claim page when it isn't in the account). An agent is told
    `clerk auth login` for an init app (it can't sign in itself), and
    `clerk open` for an SDK app, since a person has to claim it.
  - **Plain keys** (pasted from the Dashboard, say), **or an SDK keyless file
    whose claim link can't be used**: it says the folder uses the secret key
    from its file and isn't linked, then the step for what the folder holds,
    e.g. that `clerk link` finds the app by the publishable key. It doesn't
    call the app unclaimed: such an app may already be in an account.
- No token, a secret key present → Token validity **passes**: no session is
  needed. As above, only an app in no account yet is called accountless;
  otherwise it names the file the folder's secret key comes from, without
  claiming the key works: no check sends a request with a plain key.
- Stored session expired, a secret key present → **warn** (not fail): the
  folder runs on its own secret key, so logging in again is optional. As
  above, only an app in no account yet is called accountless; otherwise the key
  is named by its file.
- Signed in (has account credentials) but this directory isn't linked, a secret
  key present → **warn**, with the `clerk link` fix: the account could reach
  the fuller configuration by linking. The remedy is the step for what the
  folder holds: `clerk link` claims an init app first, and finds plain keys'
  app by its publishable key. Plain keys aren't called an accountless
  application.
- No token **and** no accountless key found anywhere → still **fail**. Accountless
  only changes the outcome when there's actually a secret key to fall back to.
- Not linked and no secret key to run on → Project linkage **fails**, with the
  `clerk link` fix. Its remedy is the step for what the folder holds, e.g. an
  SDK keyless file with no secret key gets `clerk open` for an agent, as
  `deploy` gives it.
- An env file that can't be read → no check crashes. The accountless key is then
  only one exported in the shell, and when there's none, Project linkage's
  remedy starts with the read error.

The Linked application and Instances checks are account-only (the Platform
API application/instance-list concepts have no accountless equivalent), so they
continue to skip for a project running on a secret key — the skip reason names
what the key runs instead of reading like a problem: the accountless application
for an app in no account yet, otherwise the key's file.

### iOS and macOS projects

When the directory is an Xcode project (or an `--xcode-*` flag is given), doctor
skips the env-file check, since native apps configure Clerk in Swift, and adds
read-only checks from the same engine as `clerk init`: configuration coverage,
SDK linkage and version, capabilities, Native API, registration, and the Apple
connection. It never edits the project, resolves packages, or writes to Clerk.
Without Xcode (another OS, or a Mac with only the Command Line Tools) these checks become one warning and the env-file check stays, matching `clerk init`'s fallback. If Clerk can't
be reached, the local checks still run and a warning says so.

`clerk init` sets up only the development instance, so doctor also checks the
non-Debug configurations it inspected (Release by default) against the
production instance. Each warning carries its own remedy rather than pointing
back at `clerk init`:

| Check                                 | Passes when                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production native registration        | Release's Bundle ID is registered on production with the app's App ID Prefix, and Native API is enabled there                                                                                             |
| Production associated domain: Release | The entitlements file Release signs with (resolved by Xcode, including `[sdk=…]` conditions) lists `webcredentials:<production Frontend API host>`, with `$(…)` build settings expanded as Xcode signs it |
| Production publishable key: Release   | Release passes the production instance's publishable key to `Clerk.configure`                                                                                                                             |

The publishable key is read without building, and only when the argument to
`Clerk.configure` is a string literal or an Info.plist read
(`Bundle.main.object(forInfoDictionaryKey:)` or `infoDictionary[…]`) whose
entry is a literal or a `$(BUILD_SETTING)`, so xcconfig values per
configuration count. Only the selected target's Swift files count (its
compile-sources files and synchronized folders less their membership
exceptions, or its `target-membership` entries in a `.xcproj`), less the
configuration's `EXCLUDED_SOURCE_FILE_NAMES`. Anything else is reported as
"Not verified" with the reason: a constant, a call inside `#if`, a fallback
(`?? "pk_…"`), the environment, a bundled file, a build script, or CI. Keys are compared, never printed.

Without a production instance these become one passing note, since production
is optional (the Instances check already mentions it). Selecting only Debug with
`--xcode-configuration Debug` skips them the same way. Without the flag, doctor inspects only configurations named Debug and Release, so when a target's release configuration has another name (such as Production), it warns that nothing was checked and names the configuration to pass.

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

When `clerk link` opens a claim page instead of linking (the folder's app was
created by a Clerk SDK and isn't in the account yet), the link fix is reported
as not applied: claim the app, then run `clerk link` again.

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
(a human-readable fix instruction), `fix` (a label describing
the auto-fix action), and `crashed` (see below).

Agents cannot use `--fix` directly because the fix actions are interactive.
Instead, agents should read the `remedy` field from the JSON output and
orchestrate fixes themselves (e.g., ask the user to run `clerk auth login`,
or call `clerk link --app <id>` with a known app ID).

Exit code 1 signals one or more checks failed.

## A check that crashed is not a finding

A check that throws learned nothing about what it was meant to verify, so it is
reported as the CLI's own failure rather than as a problem with the user's
project: the result carries `crashed: true` and names the check that broke, and
the command exits with the error code `doctor_check_crashed` instead of
`doctor_failed`. It still counts as a failing check — a question was asked and
has no answer — so the exit code is unchanged.

The name comes from the check registry in `index.ts`, because a check that
threw never returned a result to read one from. Both it and the name the check
gives its own results come from `CHECK_NAME` in `checks.ts`, so they cannot
drift apart.

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

Xcode projects also read, for the development and (when present) production
instances:

| Method | Endpoint                                                                           | Description                        |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `GET`  | `/v1/platform/applications/{appID}/instances/{instanceID}/native_settings`         | Whether Native API is enabled      |
| `GET`  | `/v1/platform/applications/{appID}/instances/{instanceID}/native_applications/ios` | Registered Bundle IDs and prefixes |
