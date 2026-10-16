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

Find a local `clerk/skills` checkout containing `skills/clerk-cli/SKILL.md`; check sibling directories of this CLI checkout first. If none exists and network access is available, clone `https://github.com/clerk/skills.git` into a temporary directory. Run the canonical audit from that checkout, passing this CLI checkout's path with `--source`. Do not look for the target skill in this repository. If you cannot access `clerk/skills`, stop and ask for a checkout instead of relying on a stale copy.

If using `--apply`, keep the skills checkout until its edits are committed or handed off.
