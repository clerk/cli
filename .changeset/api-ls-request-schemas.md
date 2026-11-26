---
"clerk": minor
---

Show request body fields in `clerk api ls <path>`. When the filter is an endpoint path, such as `clerk api ls /users` or `clerk api ls /platform/applications --platform`, each endpoint at that path with a request body lists its fields with their types, a `required` marker and a short description, so you can build a valid request without a trial call. Keyword filters and endpoints without a body print as before.
