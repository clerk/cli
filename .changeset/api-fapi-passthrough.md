---
"clerk": minor
---

Add `clerk api --fapi` to call an instance's public Frontend API (e.g. `clerk api --fapi /environment --app <id>`). The FAPI host is resolved from the instance's publishable key, and the request is unauthenticated since these endpoints are public, which closes the loop on verifying config changes end to end with the CLI alone.
