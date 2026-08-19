---
"clerk": patch
---

Make the `clerk api` endpoint catalog discoverable from help output and 404 responses.

- Root help now describes `api` as "Call any Clerk API endpoint (200+; `clerk api ls` to browse)" instead of "Make authenticated requests to the Clerk API", and `clerk api --help` explains that this command covers what the dedicated commands do not.
- `--platform` now explains that the Platform API has its own endpoint list, `clerk api ls` examples say which API they list (they cover the Backend API, not every endpoint), and `clerk api ls --platform` is shown as an example.
- A 404 with no parsed Clerk error code now suggests `clerk api ls <keyword>` on stderr, leaving stdout as the pipeable response body. The suggestion is scoped per surface: `--platform` appends that flag, and `--fapi` gets none since it has no endpoint catalog.
