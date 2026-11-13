---
"clerk": patch
---

`clerk logs --help` and each subcommand's help now walk the discovery flow an agent follows (`clerk logs schema --json`, then a type's fields, then `clerk logs list --type … --payload-filter …`, `clerk logs get <sia_|sua_ id>` and `--follow --json`), and `clerk logs --help` describes the `--json` output shapes, `--cursor` paging and log retention. In agent mode, every `clerk logs` error now prints as JSON with a code (`bapi_unexpected_response` for a response the CLI can't use, `log_types_unavailable` when the Backend API can't list event types yet), and `--payload-filter` or `--fields` without `--type` points at `clerk logs schema`. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
