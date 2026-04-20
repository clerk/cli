---
"clerk": patch
---

Tighten the `clerk init` bootstrap flow:

- Skip the redundant "Proceed?" scaffold confirmation when bootstrapping a new project (via `--starter` or on an empty directory). The scaffold plan is still previewed; only the now-superfluous prompt is removed since the user already opted in by starting bootstrap.
- Print bootstrap next steps (`cd <project>`, `<pm> dev`, etc.) after the optional "Install agent skills?" prompt so they remain the last thing visible when the command finishes.
