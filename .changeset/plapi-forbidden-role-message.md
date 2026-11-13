---
"clerk": patch
---

Explain Platform API `403` errors caused by your workspace role. When your role in the signed-in Clerk workspace has no Platform API access (for example Support or Viewer), every command now says so, names your role and the roles that have access, and tells you to ask a workspace owner or admin to change it or to switch workspaces and run `clerk auth logout` and `clerk auth login`. A `403` for a missing scope now names the scope and says whether your role or your `CLERK_PLATFORM_API_KEY` lacks it. `clerk auth login` no longer suggests `clerk apps create` when it can't set up a default application for this reason. In `--json` and agent mode the error keeps the API's `code` and `errors` and adds a `docsUrl`.
