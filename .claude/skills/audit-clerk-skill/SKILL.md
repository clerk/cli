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

Find a local `clerk/skills` checkout containing both `skills/clerk-cli/SKILL.md` and `.agents/skills/audit-clerk-skill/SKILL.md`. If this CLI checkout is a worktree, use the parent of `git rev-parse --path-format=absolute --git-common-dir` to find the main CLI checkout, then look for a skills checkout beside it. If none exists and network access is available, clone [clerk/skills](https://github.com/clerk/skills.git). A temporary clone is fine for a read-only audit; for `--apply`, use a checkout you will keep.

Read the entire `.agents/skills/audit-clerk-skill/SKILL.md` from the **resolved checkout**, not GitHub `main`, then run that audit from the skills checkout with this CLI checkout's path as `--source`. The [GitHub copy](https://github.com/clerk/skills/blob/main/.agents/skills/audit-clerk-skill/SKILL.md) is for reference only. Do not look for the target skill in this repository. If you cannot access `clerk/skills`, stop and ask for a checkout.

For `--apply`, create a new branch in the skills checkout before making edits. Keep that checkout and give the user its path and branch; do not delete it while it contains work that has not been committed or handed off.
