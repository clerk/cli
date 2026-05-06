---
"clerk": patch
---

Fix shell detection for fish users whose login shell is zsh. `clerk doctor` now correctly identifies fish via `FISH_VERSION`, and `clerk update` no longer shows an irrelevant `hash -r` hint.
