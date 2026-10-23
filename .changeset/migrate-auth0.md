---
"clerk": minor
---

Add `clerk migrate export auth0`, and let `clerk migrate import` read Auth0 exports, including the NDJSON file from Auth0's bulk export job. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
