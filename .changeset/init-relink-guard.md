---
"clerk": patch
---

In agent mode, `clerk init --app` no longer silently replaces a link to a different application. Inside a Git repository that link is shared by every project there, so relinking one folder switched them all. `clerk init` now stops, explains what would switch, and asks for `--relink`; with `--json`, it reports an `input-required` status.
