---
"clerk": minor
---

Surface Clerk API error codes and metadata as structured fields on `PlapiError` / `BapiError` / `FapiError`, and use them to add two recovery paths in `clerk deploy`: resume from server state when a production instance already exists, and present a friendly upgrade hint when the development instance uses features the current subscription plan doesn't allow.
