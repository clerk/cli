---
"clerk": patch
---

Stop sending telemetry for `clerk completion`. Shells re-run it on every startup when it is wired into an rc file, so its events measured shell startups rather than CLI usage.
