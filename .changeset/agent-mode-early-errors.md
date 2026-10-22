---
"clerk": patch
---

`--mode agent` now applies before `--input-json` expansion, and Commander parse errors (unknown command, unknown option) go through the same JSON error handler as other CLI errors.
