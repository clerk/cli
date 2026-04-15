---
description: Changeset requirements for non-exempt file locations
paths:
  - "packages/cli-core/src/**"
  - "packages/cli/**"
alwaysApply: false
---

Changes inside these paths are **non-exempt**: the `Enforce Changeset` workflow (`.github/workflows/enforce-changeset.yml`) fails the PR if no `.changeset/<slug>.md` exists. Every feature branch that touches these paths must include a changeset before the PR is opened or any further commits are pushed.

## Test-file exception

Test-only changes are exempt and do not need a changeset:

- `packages/**/*.test.ts`
- `packages/**/__tests__/**`

If the branch diff under non-exempt paths contains _only_ test files, no changeset is required. Skip the rules below.

## Decision flow

After staging changes (and before commit on a feature branch, or before push on a branch with an open PR), classify the cumulative branch diff:

### User-facing change → invoke `/changesets create`

Signals: any commit on the branch starts with `feat:`, `feat(`, `fix:`, `fix(`, `feat!:`, or `fix!:`; or the diff adds, removes, or changes a flag, command, exported API, env var, output format, or any other surface a CLI user can observe.

Action: invoke the `changesets` skill (`/changesets create`). The skill picks the slug, decides the bump type, writes the file, and places it on the correct commit per branch shape. Full policy: [.claude/skills/changesets/references/policy.md](../skills/changesets/references/policy.md).

### Internal change with no user-facing impact → empty changeset

Signals: every commit on the branch uses a non-user-facing prefix (`refactor:`, `chore:`, `perf:`, `build:`, `ci:`, `style:`, `docs:`, `test:`) **and** the diff has zero observable effect on the CLI's behavior or surface.

CI still requires a changeset because non-exempt paths changed. Generate an empty one to satisfy enforcement without producing a misleading changelog entry:

```sh
bun changeset --empty
```

This writes a `.changeset/<slug>.md` with no package bumps. The release that consumes it skips publishing a version bump for the change but keeps the audit trail.

Place the empty changeset following the same commit-placement rules as a real one: amend on a single-commit branch, or add a `docs(changeset):` tip commit on a multi-commit branch.

### Mixed branches

If the branch contains both user-facing and internal commits, treat it as user-facing and invoke `/changesets create`. The skill writes a real changeset whose summary covers the user-visible portion.

## Verification

Before pushing, run:

```sh
bun changeset status --since=origin/main
```

It must exit 0. If it errors with "Some packages have been changed but no changesets were found", a real or empty changeset is missing.
