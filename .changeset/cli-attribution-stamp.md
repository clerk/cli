---
"clerk": minor
---

Stamp authenticated CLI app creation with `from_source=cli` so apps created through Clerk CLI flows are attributable in Clerk's analytics. The value is set on the PLAPI request body and persists to `applications.from_source`. Requires matching PLAPI support to be deployed server-side.
