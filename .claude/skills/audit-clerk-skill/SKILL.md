---
name: audit-clerk-skill
description: Audits the Clerk CLI source tree and proposes updates to the bundled `clerk` skill so it stays in sync with the binary. Use when the user says "audit the clerk skill", "update the clerk skill", "check the skill against the code", "resync clerk skill", or after adding/renaming/removing CLI commands, flags, or agent-mode behavior.
effort: high
user-invocable: true
disable-model-invocation: true
argument-hint: "[--apply]"
---

# Audit the clerk Skill

Cross-check `skills/clerk/` against the actual CLI source in `packages/cli-core/` and propose precise edits wherever they have drifted. The binary is the source of truth; the skill is documentation that must track it.

**ultrathink** on this task. It requires building a full command tree, comparing two representations of it, and making judgment calls about what belongs in the skill vs. in `references/*.md` vs. in `--help`. Shallow passes miss drift.

## Inputs

- **Source of truth**: `packages/cli-core/src/commands/**` (one directory per top-level command), plus `packages/cli-core/src/cli.ts`, `cli-program.ts`, `mode.ts`, and anything in `packages/cli-core/src/lib/` referenced by commands (runner preference, agent mode, doctor checks, key resolution).
- **Target**: `skills/clerk/SKILL.md` and `skills/clerk/references/*.md`.
- **Template markers**: the skill uses `{{CLI_VERSION}}` placeholders substituted at install time by `clerk skill install`. Preserve them; do not expand.

## Workflow

### 1. Inventory the CLI

Walk `packages/cli-core/src/commands/` and build a structured inventory. For each top-level command and subcommand capture:

- Full path (e.g. `clerk config patch`, `clerk api ls`).
- Purpose (one line, from the command's description / help string in source).
- All flags with short form, type, default, and whether they are destructive.
- Exit codes beyond the default if the command overrides them.
- Agent-mode branches: anything gated on `isAgentMode()` / `CLERK_MODE` / TTY detection. Note what changes (prompts skipped, JSON forced, `--fix` ignored, handoff printed, etc.).
- Whether the command mutates remote state (candidate for `--dry-run` / `--yes` guidance).

Read the per-command `README.md` (`packages/cli-core/src/commands/<name>/README.md`) as a **secondary** source. These are dev-facing (documented API endpoints hit, mocked surfaces, internal contracts per `.claude/rules/commands.md`). Use them to:

- Flag commands or sub-paths marked mocked/stubbed (blockquote at top of the README). The skill should not document these as production-ready.
- Cross-check Clerk API endpoint claims in `references/recipes.md`.

Do **not** propose bundling the READMEs into `skills/clerk/references/` (symlinks or text imports). They ship internal detail agents do not need, and inflate the compiled binary. They are a reference for the audit, not for the skill.

Also capture cross-cutting behavior:

- Runner preference logic (`preferredRunner` in `lib/`): the lockfile -> runner mapping that the skill's Invoking-the-CLI table must mirror.
- Auth / key resolution order and `--app` / `--instance` resolution (cross-ref `references/auth.md`).
- `doctor` check list and the shape of `--json` output (cross-ref `references/agent-mode.md`).
- `clerk init --prompt` output (the skill claims it is an agent handoff, not an integration guide; verify).

Don't memorize output. Prefer reading the source directly over running the binary, since the binary in the worktree may be stale or unbuilt. When uncertain about runtime behavior, fall back to the tests in `packages/cli-core/src/**/*.test.ts` or `packages/cli-core/src/test/`.

### 2. Extract the skill's current claims

Read `skills/clerk/SKILL.md` and each file under `skills/clerk/references/`. Extract every concrete claim:

- Every command mentioned in the "Core commands at a glance" table and the Invoking-the-CLI table.
- Every flag called out by name.
- Every agent-mode behavior bullet.
- Every exit code / error-format claim.
- Every cross-reference to a `references/*.md` file.

### 3. Diff source vs. skill

Produce a structured diff with four buckets:

1. **Missing from skill**: commands, subcommands, flags, or behaviors that exist in the source but are not mentioned anywhere in the skill. (Example seen historically: `completion`, `deploy`, `open`, `skill`, `switch-env` were absent from the core-commands table.)
2. **Stale in skill**: claims in the skill that no longer match source - renamed flags, changed defaults, removed commands, shifted exit codes, agent-mode branches that were reworked.
3. **Thin in skill**: commands mentioned but under-specified relative to their real complexity or footgun surface (destructive mutations without `--dry-run` callouts, flags with non-obvious interactions, agent-mode divergence not documented).
4. **Over-specified**: details the skill encodes that `clerk <cmd> --help` or the referenced files already cover better. Candidates for deletion to stay under the 500-line budget.

For every entry in buckets 1-3, cite the source file and line and the target skill location.

### 4. Decide placement

Not every gap belongs in `SKILL.md`. Apply this routing:

- **Core loop / mental model / safety**: stays in `SKILL.md`.
- **Per-command flag tables, recipes, edge cases**: belong in `references/recipes.md` or a new reference file.
- **Agent-mode branches**: belong in `references/agent-mode.md`; `SKILL.md` gets a summary bullet only.
- **Auth / targeting / key resolution**: `references/auth.md`.

**Prefer `--help` over enumeration.** `clerk <command> --help` is generated from the Commander tree and can't drift; it also renders each command's `setExamples([...])` block. Before expanding a flag table, ask whether the agent could just run `--help` once. Route as follows:

- Flags with non-obvious interactions, destructive semantics, or agent-mode divergence: document in the skill.
- Flags that are self-explanatory from `--help`: do not enumerate. If the skill currently lists them and there's no hidden gotcha, propose a `polish` edit that removes the enumeration and points at `--help`.
- Example syntax: prefer a sentence like "see `clerk <cmd> --help` for examples" over copying examples into the skill (which risks drifting from the source `setExamples([...])`).

Cuts that shrink the skill toward `--help` are first-class proposals, not optional cleanup. A smaller skill that routes agents to `--help` ages better than a larger one that tries to mirror every flag.

If a new reference file is warranted (e.g. a `references/commands.md` table), propose it explicitly rather than bloating `SKILL.md`.

### 5. Propose edits

Emit a review-ready proposal. For each change:

- Path (`skills/clerk/SKILL.md` or `skills/clerk/references/<file>.md`).
- Why (source citation: `packages/cli-core/src/commands/<cmd>/<file>.ts:<line>`).
- Either a unified diff (preferred) or a before/after block for prose sections.
- Severity: `drift` (factually wrong today), `gap` (missing coverage), `polish` (clearer wording, better placement, or cuts that route the agent to `--help` instead of duplicating it).

Group the proposal by file. Do **not** touch `{{CLI_VERSION}}` markers. Do **not** rewrite sections that are still accurate just because they are near a change.

### 6. Apply or hand back

Default: present the proposal and stop. The user reviews, then says apply.

If invoked as `/audit-clerk-skill --apply`, apply `drift` and `gap` edits directly but still list `polish` suggestions for review. Run `bun run format` after applying so markdown tables and frontmatter match repo style.

## Guardrails

- **Never invent flags.** If a flag appears in a test but not in the command's argument parser, treat it as test-only and flag it for human review.
- **Preserve voice.** The existing skill is terse and third-person; match it. No first- or second-person drift.
- **No em-dashes** anywhere in proposals (repo style rule).
- **Respect the template.** `{{CLI_VERSION}}` stays verbatim. The Invoking-the-CLI runner table is generated from `preferredRunner` logic; if that logic changes, update the table, otherwise leave it alone.
- **Stay within the 500-line guidance** for `SKILL.md`. When the budget is tight, move content to `references/` rather than deleting it outright.

## Output shape

Return the proposal as:

```
# clerk skill audit — <YYYY-MM-DD>

## Summary
<counts per bucket, one-line headline of the biggest drift>

## skills/clerk/SKILL.md
### <section name>
- [drift|gap|polish] <one-line description>
  - source: packages/cli-core/src/commands/<...>:<line>
  - <diff or before/after>

## skills/clerk/references/<file>.md
...

## New files (if any)
...

## Open questions
<things that need human judgment before applying>
```

Keep it skimmable. The user should be able to approve or reject each entry individually.
