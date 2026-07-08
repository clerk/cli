---
"clerk": patch
---

Resolve the instance explicitly instead of silently defaulting to development: interactive flows (`clerk impersonate`, `clerk impersonate revoke`, `clerk users open`, the create wizard, and the application-picker fallback) now ask in human mode whenever the resolved app has more than one instance and no `--instance` flag pins one, and agent mode errors asking for an explicit `--instance` rather than defaulting — so the same command can't resolve a different instance depending on which instances the app happens to have. User lookups that find no match name the searched app and instance in the error, and instances targeted by raw ID are labeled by their environment type so the production impersonation warning always fires.
