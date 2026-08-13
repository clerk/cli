---
"clerk": minor
---

Recover from links that predate a production instance. A project linked before its production instance existed — for example one created afterwards in the Clerk Dashboard — previously failed every `--instance prod` command with "No production instance configured. Run `clerk link` to set one up", which was a dead end: `clerk link` only offers to re-link to a _different_ application. Commands that resolve an instance through the linked profile now check the application before reporting. If the instance exists upstream, they offer to update the link and continue (agent mode fails instead, pointing at the new `clerk link --refresh`); if the application genuinely has no production instance, they point at `clerk deploy`, which is the only command that can create one. `clerk link --refresh` re-reads the linked application's instances without changing which application the project is linked to, and never prompts.
