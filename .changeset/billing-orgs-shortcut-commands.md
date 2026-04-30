---
"clerk": minor
---

Add `clerk enable` and `clerk disable` top-level commands for toggling features on the linked instance:

- `clerk enable orgs` / `clerk disable orgs` — toggle organizations, with optional `--force-selection`, `--auto-create`, `--max-members <n>`, and `--domains` configuration on enable.
- `clerk enable billing [--for org,user]` / `clerk disable billing [--for org,user]` — toggle billing for organizations and/or users. `--for` defaults to both targets when omitted; enabling for `org` also enables organizations. After a successful enable, offers to install the `clerk-billing` agent skill (suppress with `--no-skills`).

All commands share the diff-and-confirm safety flow used by `clerk config patch`, including `--dry-run` and `--yes` flags.
