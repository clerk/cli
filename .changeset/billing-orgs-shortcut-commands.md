---
"clerk": minor
---

Add `clerk enable` and `clerk disable` top-level commands for toggling features on the linked instance.

- `clerk enable orgs` / `clerk disable orgs` — toggle organizations, with `--force-selection`, `--auto-create`, `--max-members <n>`, and `--domains` on enable.
- `clerk enable billing [--for org,user]` / `clerk disable billing [--for org,user]` — toggle billing for organizations and/or users. `--for` defaults to both; enabling for `org` cascades to enabling organizations. Enable also offers to install the `clerk-billing` agent skill (suppress with `--no-skills`).
