---
"clerk": minor
---

Add direct user-management commands to `clerk users`:

- `clerk users list` with pagination, query search, repeatable identifier filters (`--email-address`, `--phone-number`, `--username`, `--user-id`, `--external-id`), `--order-by` over Clerk's common user ordering fields, and an application picker when invoked without a linked project, env var, or targeting flag. `--limit` defaults to 100 and accepts 1-250. `--json` (and agent mode) emits `{ data, hasMore }` so callers can paginate without a separate count call; the human-mode table footer surfaces the next `--offset` when more pages are available. The interactive user picker (used by `clerk users open` and other update flows) shows a "More results, refine your search" hint when matches overflow its window.
- `clerk users open [user-id]` for opening a user's Clerk dashboard page in the browser, with interactive pickers for the application and the user, plus `--print` for emitting the URL.

Both commands appear in the interactive `clerk users` menu.
