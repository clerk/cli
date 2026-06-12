---
"clerk": patch
---

Fix the OAuth provider walkthrough in `clerk deploy` printing the redirect URI on the wrong subdomain. Previously, the walkthrough showed `https://accounts.{domain}/v1/oauth_callback`, but the callback is served by the Frontend API, so pasting the value into a provider console caused `redirect_uri_mismatch`. The walkthrough now prints the instance's `frontend_api_url` (e.g. `https://clerk.{domain}/v1/oauth_callback`), matching the value shown in the Clerk Dashboard.
