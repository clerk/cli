---
"clerk": minor
---

Add `clerk users create` for creating users from curated flags (`--email`, `--phone`, `--username`, `--password`, `--first-name`, `--last-name`, `--external-id`) or a raw BAPI request body via `-d, --data <json>` or `--file <path>`. The command supports `--dry-run`, `--yes`, and `--json`. BAPI enforces identifier and required-field rules, so any BAPI secret key (`CLERK_SECRET_KEY`, `--secret-key`, or `--app`-resolved) is sufficient — no `applications:manage` Platform API scope is needed. Program-level `--input-json` drives the curated flags from a JSON object; `-d` / `--file` cover fields the curated flags don't expose.
