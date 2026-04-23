---
"clerk": patch
---

Fix `clerk doctor` falsely reporting the CLI config file as missing. The check was looking at a legacy path (`~/.clerk/config.json`) instead of the platform-appropriate location used by the rest of the CLI.
