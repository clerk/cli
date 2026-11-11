---
"clerk": minor
---

Add event filters to `clerk logs list`: `--type` (with a trailing `*`, like `sign_in.*`), `--user`, `--identifier`, `--actor`, `--subject`, `--session`, `--client`, `--ip`, `--trace`, `--impersonator`, `--end-user-only`, and `--payload-filter <path=value>` to match a payload field of a type. Use `--fields` to show chosen payload fields in a `PAYLOAD` column, and `--match any` to keep logs that match any filter instead of all of them. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
