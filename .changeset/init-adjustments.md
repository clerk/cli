---
"clerk": patch
---

Skip the redundant "Proceed?" scaffold confirmation when `clerk init` bootstraps a new project (via `--starter` or on an empty directory). The scaffold plan is still previewed; only the now-superfluous prompt is removed since the user already opted in by starting bootstrap.
