---
"clerk": patch
---

`clerk mcp run` now relays a structured JSON-RPC error from the upstream server verbatim instead of collapsing it into a generic -32000 error, so a client can see reserved codes like `HeaderMismatch` (-32020) and `UnsupportedProtocolVersion` (-32022) and drive the 2026-07-28 negotiation-retry flow.
