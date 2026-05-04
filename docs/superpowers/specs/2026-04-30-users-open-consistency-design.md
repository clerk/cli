# Clerk Users Open Consistency Design

Date: 2026-04-30
Status: Ready for review
Owner: CLI

## Summary

Make `clerk users open` consistent with `clerk users list` and `clerk users create` by aligning its targeting and auth semantics with the existing Backend API command family.

This change fixes the current `users open` regressions without broadening the scope into a new interactive pagination system.

## Goals

- Make `users open` accept targeting flags with the same semantics as `users list` and `users create`.
- Fix the broken interactive picker so human-mode `clerk users open` can populate user choices again.
- Report the actual resolved instance label in human and agent output instead of hardcoding `development`.
- Keep the implementation narrow and local to `users open` and the existing picker.

## Non-Goals

- Adding lazy next-page or previous-page loading to the interactive picker.
- Making `clerk users list` auto-fetch all API pages.
- Extending `listage` with a generic remote-pagination abstraction.
- Redesigning the overall `users` command family beyond `open` consistency fixes.

## Problem Statement

`clerk users open` currently diverges from the rest of the `users` family in three ways:

1. It uses a custom instance-context resolver that rejects `--secret-key` combined with `--app` or `--instance`, unlike `users list` and `users create`.
2. Its interactive picker still expects a raw array response from `/v1/users`, so it fails when Clerk returns `{ data, totalCount }`.
3. It hardcodes `development` in agent output and human logging even when the command opens a user in another instance.

These inconsistencies create both functional regressions and confusing command semantics.

## Decision Summary

The approved contract is:

- `users open` should follow the same auth-resolution rule as `users list` and `users create`.
- `--secret-key` remains supported for Backend API user lookup.
- `--app` and `--instance` remain the source of dashboard URL targeting.
- `--secret-key` alone remains insufficient for `users open`, because opening the dashboard also requires a resolvable app target.
- The interactive picker should be fixed to parse Clerk's paginated `/users` response shape, but should remain a single-request result set per search term for now.

## Command Contract

### Supported Invocations

`clerk users open` should accept the same option set already used by `users list` and `users create`, with one command-specific constraint for dashboard URL construction.

Supported resolved invocations:

- linked project only
- `--app <app-id>`
- `--app <app-id> --instance <instance>`
- `--secret-key <key> --app <app-id>`
- `--secret-key <key> --app <app-id> --instance <instance>`

### Resolution Rules

For `users open`, resolution is split into two concerns:

- Backend API auth: resolved through the existing `resolveBapiSecretKey()` helper, exactly like `users list` and `users create`
- Dashboard targeting: resolved from app context so the command can build a URL from `appId`, `instanceId`, and `instanceLabel`

This yields the following behavior:

- If `--secret-key` is present, it is used for Backend API requests.
- If `--secret-key` is absent, Backend API auth is derived the same way as the other commands: `--app`, `CLERK_SECRET_KEY`, or linked-project resolution.
- Dashboard targeting comes from explicit `--app` and `--instance` when provided, otherwise from linked-project or interactive app selection in human mode.

### Unsupported Invocation

`clerk users open --secret-key <key>` without any resolvable app context remains invalid.

Reason:

- a secret key is enough to talk to `/v1/users`
- it is not enough to build the dashboard URL, which requires an application target and instance target

The usage error should explain that `users open` needs an app target to construct the dashboard URL.

## Interactive Picker Behavior

The picker used by `clerk users open` should remain search-based and should continue to fetch one result page per search term.

Approved behavior:

- keep the current `limit=20` request size
- keep one API request per search term
- parse both raw-array responses and `{ data, totalCount }` responses
- render the returned `data` rows as choices

Explicitly deferred:

- loading the next API page when the user arrows past the last loaded result
- loading the previous API page when the user arrows above the first loaded result
- aggregating all pages in memory

## Output Rules

`users open` should report the actual resolved target instance everywhere it surfaces command context.

Requirements:

- agent-mode JSON must emit the resolved `instanceLabel`
- human-mode status logging must print the resolved `instanceLabel`
- URL construction continues to use the resolved `appId` and `instanceId`

This fixes the current mismatch where the command opens the correct URL while claiming the target was `development`.

## Error Handling

### Missing Dashboard Context

When no app context can be resolved, `users open` should fail with the same class of linked-project or targeting errors already used elsewhere in the CLI.

If `--secret-key` is present but no app can be resolved, the message should make the missing requirement explicit: the command still needs an app target to build the dashboard URL.

### Picker Data Shape

If `/v1/users` returns an unexpected body shape, the picker should degrade to no choices rather than crashing. This preserves current prompt behavior while fixing the normal `{ data, totalCount }` case.

## Internal Architecture

Keep the implementation local and narrow.

Changes:

- update `users open` to resolve Backend API auth through `resolveBapiSecretKey()`
- resolve dashboard targeting through app-context resolution instead of the current all-in-one users resolver path
- update the picker mapper to read paginated `/users` responses
- remove the hardcoded `development` label in `users open`

Avoid:

- changing `users list` behavior
- changing `listage` APIs
- adding a new generic pagination abstraction in this pass

## Testing

Required coverage:

- `users open` accepts `--secret-key` combined with `--app` and optional `--instance`
- `users open --secret-key` alone still fails with an app-targeting usage error
- `users open` emits the resolved `instanceLabel` in agent mode
- `users open` logs the resolved `instanceLabel` in human mode
- `pickUser()` accepts `{ data, totalCount }` from `/v1/users`

Tests that should remain unchanged:

- `users list` manual pagination behavior
- any `listage` prompt behavior unrelated to the picker response shape

## Rollout Notes

This change intentionally fixes consistency and correctness without claiming support for interactive cross-page scrolling.

Future pagination work, if needed, should be treated as a separate design and implementation effort because the current prompt stack does not support remote boundary pagination by configuration alone.
