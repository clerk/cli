---
"clerk": patch
---

Expand `--verbose` debug output across the CLI and surface silent environment fallbacks.

- Every outbound HTTP call (platform API, backend API, OAuth, npm registry) now logs its URL, method, status, and response body on error under `--verbose`.
- New debug coverage for the credential store, config file I/O, environment resolution, auth callback server, git detection, framework detection, autolink, and package-manager runner probing.
- Warn without `--verbose` when the saved environment is not available in the current binary, instead of silently falling back to production.
