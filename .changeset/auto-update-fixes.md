---
"clerk": patch
---

Fix `clerk update` to upgrade the binary that is actually running. With multiple installs on the same machine (e.g. bun and asdf-npm), the command now picks the install that owns the currently-running `clerk` as the primary target instead of the first `PATH` match, so `clerk -v` reflects the upgrade without needing `--all`.
