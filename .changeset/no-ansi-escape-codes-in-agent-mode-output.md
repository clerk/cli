---
"clerk": patch
---

Print plain text without terminal color codes in agent mode, so AI agents no longer see escape sequences in command output when they run without `--json`. Pass `--mode human` or set `CLERK_MODE=human` to keep colors.
