---
"clerk": patch
---

Fix `install.sh --install-dir <path>` so it creates the directory when it does not already exist, matching the behavior of the `~/.local/bin` fallback.
