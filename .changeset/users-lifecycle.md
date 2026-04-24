---
"clerk": minor
---

Add user lifecycle commands: `clerk users delete`, `clerk users ban`, `clerk users unban`, `clerk users lock`, and `clerk users unlock`. Each performs a direct state transition via BAPI and supports the shared `--app`, `--instance`, `--secret-key`, `--dry-run`, `--yes`, and `--json` flags.
