---
"clerk": patch
---

Fix agent-mode linking flows. `clerk link --app <id>` now works non-interactively in agent mode, `clerk link` without `--app` tries deterministic autolink before failing with a usage error, and `clerk unlink --yes` now unlinks instead of printing guidance. The bundled `skills/clerk` docs were updated to match the new agent-mode behavior.
