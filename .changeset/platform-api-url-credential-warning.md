---
"clerk": patch
---

Warn (in human mode) when `CLERK_PLATFORM_API_URL` routes requests to a host that differs from the active environment's URL, since credentials are keyed by environment name and not by URL. `clerk doctor` now also reports the active environment and its API URL so the mismatch is visible.
