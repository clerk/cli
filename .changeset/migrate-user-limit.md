---
"clerk": patch
---

Check `clerk migrate import` users against the instance's own user limit, on development and production instances, once Clerk's API reports it. Until then the checks still assume 100 for development instances (or `CLERK_MIGRATE_DEV_USER_LIMIT`) and no limit for production. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
