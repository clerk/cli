# Doctor Command

Runs a series of diagnostic checks on your Clerk CLI setup and reports
the status of each check. The command is read-only by default. `--fix` and the
explicit Xcode execution flags are the only modes which can change local state.

## Usage

```sh
clerk doctor             # Run all checks
clerk doctor --verbose   # Show detailed output
clerk doctor --json      # Output results as JSON
clerk doctor --spotlight # Only show warnings and failures
clerk doctor --fix       # Offer to auto-fix issues
clerk doctor --target MyApp
clerk doctor --target MyApp --build
clerk doctor --target MyApp --resolve-packages --build
clerk doctor --target MyApp --simulator --device <udid>
```

## Options

| Flag                 | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `--verbose`          | Show detailed diagnostic info for each check                                   |
| `--json`             | Output results as machine-readable JSON                                        |
| `--spotlight`        | Only show warnings and failures (hide passing checks)                          |
| `--fix`              | Offer to auto-fix issues with known remedies                                   |
| `--target`           | Select an iOS application target by name or object ID                          |
| `--xcode-container`  | Select an inspected `.xcodeproj` or `.xcworkspace` for execution checks        |
| `--scheme`           | Select an Xcode scheme for execution checks                                    |
| `--resolve-packages` | Explicitly allow Xcode to resolve Swift packages and update `Package.resolved` |
| `--build`            | Build the selected iOS app for Simulator in an isolated directory              |
| `--simulator`        | Build, install, and launch the selected app in Simulator                       |
| `--device`           | Simulator UDID or exact device name (requires `--simulator`)                   |

## Checks

| Check                 | Category       | What it verifies                                                                                                                                                                                     |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account credentials   | Authentication | Credential store has a session or a Platform API key is configured                                                                                                                                   |
| Token validity        | Authentication | OAuth access is verified through `/oauth/userinfo` or an account-scoped application-list fallback; Platform API-key access uses the same read-only application-list request                          |
| Project linkage       | Project        | Current directory is linked to a Clerk app                                                                                                                                                           |
| Linked application    | Project        | Linked application ID is accessible via the API                                                                                                                                                      |
| Instances             | Project        | Configured dev/prod instance IDs match the application's instances                                                                                                                                   |
| Environment variables | Environment    | Non-iOS projects have Clerk keys in `.env.local` or `.env`                                                                                                                                           |
| CLI configuration     | Configuration  | CLI config file exists and parses                                                                                                                                                                    |
| Shell completion      | Configuration  | Shell autocompletion is installed for the detected shell                                                                                                                                             |
| MCP server            | Integration    | If a Clerk MCP entry is installed, every distinct configured server answers the `initialize` handshake; warns on an unreadable client config (skipped when nothing is installed; warns, never fails) |

### iOS projects

When the current directory contains an Xcode project or `--target` is provided,
doctor replaces the web `.env` check with the same semantic Xcode, Swift, and
entitlements inspection used by `clerk init`. It reports separate results for:

- application-target selection;
- ClerkKit and ClerkKitUI product linkage;
- `Clerk.configure` and, for direct literal configuration, the selected target's effective development key;
- SwiftUI environment injection and authentication-flow evidence;
- AuthView's enabled methods and required local Apple capability;
- Associated Domains and the optional Sign in with Apple entitlement;
- Native API state and the exact Bundle ID registration on the linked
  development instance; and
- the Clerk Apple connection when the selected target already declares the
  native Apple entitlement.

iOS diagnostics never require a secret key in the Xcode project or an env
file. A direct literal publishable key is compared with the linked development
application using only redacted Frontend API host metadata. For a single
startup `Clerk.configure` call that uses a custom publishable-key source,
Doctor verifies that the call exists but does not inspect its value. Once the
project is linked, Doctor uses the explicitly selected development application
for read-only AuthView, Native Application, Associated Domains, and Apple
checks; this does not prove that the custom publishable key belongs to that
application. Keys, provider credentials, and raw remote config are not included
in human or JSON output. AuthView, Native Application, and Apple remote checks
are GET-only. Their remedies point back to `clerk init`; `doctor --fix` never
enables an auth strategy or changes Native Application state.

Plain `clerk doctor` remains read-only and does not invoke Xcode. The execution
flags are deliberately opt-in because Xcode can run package manifests, plugins,
macros, and project build scripts:

- `--resolve-packages` is the only mode allowed to create or update the
  selected container's shared `Package.resolved`.
- `--build` requires a locked remote package graph, verifies the chosen scheme
  belongs to the selected target, disables signing, filters Clerk credentials
  from the child environment, and uses isolated DerivedData and package
  checkouts. Without `--resolve-packages`, it builds through a temporary
  workspace with a private copy of `Package.resolved`.
- `--simulator` additionally installs and launches that isolated build. It
  never guesses among multiple devices; agent mode requires `--device`.

A successful build or launch is not a successful authentication test. Doctor
still asks the developer to verify sign-in, sign-out, relaunch, and any redirect
methods in the app. Projects with a custom publishable-key source are built but
must be launched from Xcode, because `simctl launch` cannot reproduce or verify
arbitrary custom runtime inputs.

### Keyless applications

The Authentication token, Token validity, and Project linkage checks resolve
the same keyless fallback the rest of the CLI uses (`lib/keyless-target.ts`):
a project with no account session and no linked profile, but a `sk_...` key
on disk (or in `CLERK_SECRET_KEY`/framework env var), is running on an
**unclaimed keyless application** — a legitimate, healthy state, not a broken
one.

- No token, keyless key present → **pass**, naming the instance. The claim
  hint depends on where the app came from: with a `.clerk/keyless.json`
  breadcrumb (left by `clerk init`) it says `clerk auth login` claims it;
  without one — an SDK-minted `.clerk/.tmp/keyless.json`, or a hand-copied
  `CLERK_SECRET_KEY` — it says to claim from the Clerk Dashboard instead,
  because `clerk auth login` only auto-claims apps `clerk init` created.
- Stored session expired, keyless key present → **warn** (not fail): the
  keyless key still works, logging in again is optional.
- Signed in (has account credentials) but this directory isn't linked, keyless
  key present → **warn**: the account could reach the fuller configuration by
  running `clerk link`, so that's called out unlike the fully unclaimed case.
- No token **and** no keyless key found anywhere → still **fail**. Keyless
  only changes the outcome when there's actually a secret key to fall back to.

The Linked application and Instances checks are account-only (the Platform
API application/instance-list concepts have no keyless equivalent), so they
continue to skip for a keyless project — the skip reason names the keyless
application instead of reading like a problem.

## Auto-Fix (`--fix`)

When `--fix` is passed in human mode, the command prompts to fix each
issue after all checks complete. After applying fixes, all checks are
re-run to verify the results.

`--fix` only works in human mode because the underlying fix actions are
interactive (`clerk auth login` opens a browser, `clerk link` shows a
picker). It is ignored in `--json` mode and agent mode.

`--fix` cannot be combined with Xcode execution flags. This prevents the
post-fix verification pass from resolving, building, or launching a project a
second time.

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

| Method | Endpoint                                                                           | Description                                                                       |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/oauth/userinfo`                                                                  | Validates the stored auth token                                                   |
| `GET`  | `/v1/platform/applications/{appId}`                                                | Verifies the linked app and its instances exist                                   |
| `GET`  | `/v1/platform/applications/{appId}/instances/{instanceId}/native_settings`         | Verifies Native API state for iOS projects                                        |
| `GET`  | `/v1/platform/applications/{appId}/instances/{instanceId}/native_applications/ios` | Verifies the exact iOS Bundle ID registration                                     |
| `GET`  | `/v1/platform/applications/{appId}/instances/{instanceId}/config`                  | Audits the Apple connection when native Apple is relevant                         |
| `GET`  | `/v1/platform/applications/{appId}/instances/{instanceId}/config/schema`           | Determines whether an unhealthy Apple connection can be safely reconciled by init |
| `GET`  | `https://{fapiHost}/v1/environment`                                                | Verifies whether AuthView currently offers native Apple sign-in                   |
| `GET`  | `/v1/instance`                                                                     | Names the keyless application (best-effort, via its secret key)                   |
