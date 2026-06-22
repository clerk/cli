---
"clerk": patch
---

Stop showing the "possible sandboxed run" hint for ordinary network failures (unreachable host, VPN, DNS) in agent mode. The hint now requires a permission-like error before suggesting a sandbox, and is a single line.
