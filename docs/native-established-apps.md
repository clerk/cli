# Native Apple setup

Run `clerk init` from an iOS or macOS app directory. The public command uses one
setup engine for both `project.pbxproj` and `project.xcproj`. Xcode is required;
for JSON projects, the CLI can select a compatible Xcode installed in
`/Applications` without changing the system selection. An explicit `DEVELOPER_DIR`
is respected.

## Routine setup

The CLI discovers app targets, including local projects inside a workspace. It
selects a unique app automatically and offers a picker when several exist.
`--project` and `--target` select explicitly. Debug and Release are inspected by
default; other configurations are listed for review with `--configuration`.
Only the selected iOS or macOS build context is configured; other destinations,
including Catalyst and visionOS, need separate review.

After signing in and choosing or creating a Clerk application, init reads its
public development key. It discovers an ordinary Bundle ID from Xcode and reuses
an App ID Prefix from a matching Clerk registration. Missing or conflicting
identity requires a question or explicit `--bundle-id` / `--app-id-prefix`.
An Apple signing Team ID is not automatically substituted for an App ID Prefix.

Setup previews affected files and remote changes before applying them. It:

- Links ClerkKit and optionally ClerkKitUI, preserving existing package policy and
  declared products. New starters default to both; a custom app offers a product
  choice. `--sdk core|ui` selects explicitly. Noninteractive new setups default to
  both products.
- Resolves existing packages if they prevent initial inspection, then downloads
  Clerk after adding it. Progress and retry guidance are shown.
- Adds iOS Associated Domains for the chosen Clerk development instance, even when
  the app has custom Swift startup. For sandboxed macOS apps, enables outgoing
  network access. Supported missing entitlement files are created automatically.
- Registers the Bundle ID / App ID Prefix and enables Native API.
- Offers native Sign in with Apple. Opting in adds its entitlement and configures
  the native Apple provider in Clerk, preserving web credentials. An already
  enabled Apple provider also causes its local entitlement to be configured.

Generated projects (XcodeGen/Tuist), unsupported package arrangements, ambiguous
paths, and shared entitlement ownership receive specific manual guidance. A
linked app authorizes configuration for that app; the CLI does not prove a custom
runtime key matches it.

## Swift integration

An unchanged standard SwiftUI starter receives `Clerk.configure` and
`.environment(Clerk.shared)` in its existing app file. The optional sign-in UI
prompt or `--prebuilt-auth-ui` adds SDK components to the unchanged starter view.
There are no provider wrappers or generated abstraction APIs. Installing ClerkKitUI
alone does not authorize adding UI.

The recipe matches the known starter token sequence or its own output, preserving
ordinary header comments and whitespace differences. Customized startup and UI
remain untouched. Use the [Swift quickstart](https://clerk.com/docs/ios/getting-started/quickstart)
or the structured handoff to complete those edits. No general Swift parser tries
to infer navigation, authentication logic, or custom key loading.

Human completion output summarizes completed setup and gives two next steps:
finish Swift integration when needed, then build/test; and the quickstart link.
Actual setup failures or unsupported settings remain visible above those steps.

## Agents, inspection, and recovery

`clerk init --yes --json --app app_...` returns completed CLI work, remaining setup,
and source/build tasks. Authentication must already be available. This explicit
handoff includes the development publishable key needed by the agent, but never a
secret key or provider credentials. Preview output redacts the key.
It also returns `handoff.xcode.developerDir` from Xcode's build settings and the
project format, so the agent can reuse the same Xcode with `DEVELOPER_DIR`.
Ordinary agent setup ends after pending Swift integration, doctor, and one unsigned
Debug build for an available simulator or the current Mac. Integration errors can
be corrected and rebuilt; environment and unrelated build blockers are reported.
Release builds, app launches, and authentication tests require a separate user
request. "Setup complete; sign-in not tested" is a valid stopping point.
`--yes` alone never opts into Apple activation or UI insertion. Ambiguous targets
and missing identities are reported as structured input requirements.

`clerk init --dry-run --json` inspects without login, remote reads, or setup edits.
`clerk doctor` checks SDK linkage/version requirements, configuration coverage,
capabilities, Native API, registration, and the Apple provider using GET-only
requests. Doctor can read Native API and existing registrations before a prefix
is known. Neither inspection command initiates package resolution or builds;
Xcode may still touch its own caches. Unresolved dependencies can prevent a dry
inspection; normal init resolves them automatically.

Custom Swift integration, compilation, signing, and actual sign-in remain
unverified. Machine setup results always include `appIntegrationComplete: false`.
Successful CLI work exits 0 even when source integration/build verification remains;
manual CLI setup requirements exit 2, and failed setup exits nonzero. Doctor exits
1 for failures and 0 for passing checks or warnings.

Edits use stale-content checks, per-file atomic replacement, and adjacent backups.
Existing Git edits are preserved in those backups. If a later local write fails,
earlier writes are restored only when unchanged since the CLI wrote them; later
user edits are preserved and reported for review. Package or remote failures retain
useful local edits and report unfinished work. Remote registration retries use
persistent idempotency keys. This is ordinary failure recovery, not a transaction
across local files and remote services or a durable crash journal.
