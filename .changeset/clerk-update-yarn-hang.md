---
"clerk": patch
---

Fix `clerk update` hanging when a corepack-shimmed package manager (e.g. yarn) prompts on stdin to download itself on first use. Package-manager probes now run with stdin detached, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, and a 1.5s timeout, so a missing or uninitialized PM is treated as not installed instead of blocking the command.
