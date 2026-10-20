---
"clerk": patch
---

Check `clerk migrate import` against the user limit Clerk reports for the instance, so a development instance Clerk has raised no longer rejects users it has room for. `CLERK_MIGRATE_DEV_USER_LIMIT` is now only a fallback for when Clerk doesn't report a limit, and `--json` says where the limit came from. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
