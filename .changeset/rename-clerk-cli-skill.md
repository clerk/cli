---
"clerk": minor
---

Rename the bundled agent skill from `clerk` to `clerk-cli` for more clarity during install. After upgrading, `clerk skill install` (and the install step in `clerk init`) writes the skill to `<agent-dir>/skills/clerk-cli/` instead of `<agent-dir>/skills/clerk/`. Existing `skills/clerk/` directories from prior installs are left in place; remove them manually if you want to avoid duplicate context.
