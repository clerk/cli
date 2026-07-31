---
"clerk": patch
---

Support MCP 2026-07-28 servers in `clerk doctor` and `clerk mcp run`.

- `clerk doctor` now probes with the modern `server/discover` handshake first and falls back to the legacy `initialize` handshake, so servers speaking only the 2026-07-28 revision are reported as healthy while older servers keep probing correctly.
- `clerk mcp run` now sends the request-metadata headers the 2026-07-28 revision requires (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-*` mirroring for `x-mcp-header` tool parameters), so strict new-spec servers no longer reject relayed requests, and it stays connected to stateless servers that never issue a session id.
