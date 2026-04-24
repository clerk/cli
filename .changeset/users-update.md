---
"clerk": minor
---

Add `clerk users update <user-id>` for updating a user from curated flags (`--username`, `--password`, `--first-name`, `--last-name`, `--external-id`) or a raw BAPI request body via `-d, --data <json>` or `--file <path>`. The command is config-aware and validates fields against the target instance's user config before sending the PATCH request.
