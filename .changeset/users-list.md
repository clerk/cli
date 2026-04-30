---
"clerk": minor
---

Add direct user-management commands to `clerk users`:

- `clerk users list` with pagination, query search, repeatable identifier filters (`--email-address`, `--phone-number`, `--username`, `--user-id`, `--external-id`), `--order-by` over Clerk's common user ordering fields, and an application picker when invoked without a linked project, env var, or targeting flag.
- `clerk users open [user-id]` for opening a user's Clerk dashboard page in the browser, with interactive pickers for the application and the user, plus `--print` for emitting the URL.

Both commands appear in the interactive `clerk users` menu.
