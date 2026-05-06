---
"clerk": patch
---

Honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables for outbound HTTP requests.

Bun's `fetch()` does not read these variables automatically, which made tools like mitmproxy and Charles unable to inspect the CLI's traffic. The `loggedFetch` helper now resolves a proxy from the standard env vars (uppercase or lowercase) and passes it through Bun's per-request `proxy` option. Localhost is always skipped so the local OAuth callback listener is never proxied. With `--verbose`, the chosen proxy is logged alongside the request.
