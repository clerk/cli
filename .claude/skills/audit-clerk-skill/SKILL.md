---
name: audit-clerk-skill
description: Audit the Clerk CLI source against the canonical clerk-cli skill in clerk/skills. Use when asked to audit or update the clerk-cli skill after CLI commands, flags, or agent-mode behavior change.
effort: high
user-invocable: true
disable-model-invocation: true
argument-hint: "[--apply]"
metadata:
  internal: true
---

# Audit the clerk-cli Skill

The audit instructions are maintained in [clerk/skills](https://github.com/clerk/skills/blob/main/.agents/skills/audit-clerk-skill/SKILL.md). Read that entire skill before starting; do not use this pointer as a substitute for its workflow.

Run the canonical audit against this CLI checkout as the source (its `--source <path>` option) and `skills/clerk-cli/` in a clerk/skills checkout as the target. Do not look for the target skill in this repository. If you cannot access the canonical instructions, stop and ask for access instead of relying on a stale copy.
