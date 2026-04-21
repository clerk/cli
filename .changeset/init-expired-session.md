---
"clerk": patch
---

Handle expired OAuth sessions gracefully in `clerk init` and `clerk link`. When a stored token is no longer valid, keyless-capable frameworks (e.g. Next.js) automatically drop into keyless mode during `clerk init --starter` with a note explaining the fallback; non-keyless frameworks print "Your previous session expired — signing you back in…" before opening the OAuth browser. `clerk link` now catches 401s from the Platform API and re-authenticates inline so an expired token can no longer surface as a raw error.
