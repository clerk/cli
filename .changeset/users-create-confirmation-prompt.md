---
"clerk": patch
---

Make `clerk users create` confirm before writing. The command registers `--yes` as "Skip confirmation prompt" and its examples recommend passing it, but no prompt existed, so the flag did nothing and the user was created immediately. Human mode now previews the redacted request body and asks before the POST. Agent mode is unchanged: it never prompts, so `--dry-run` remains the safety net there.
