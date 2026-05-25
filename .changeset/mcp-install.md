---
"clerk": minor
---

Add `clerk mcp install`, `list`, and `uninstall` to register the Clerk remote MCP server (`https://mcp.clerk.com/mcp`) in Claude Code, Cursor, VS Code, Windsurf, and Gemini. `clerk doctor` gains an MCP reachability check that probes the configured server via the MCP `initialize` handshake when an entry is installed. The URL comes from the active env profile's new `mcpUrl` field (or the `CLERK_MCP_URL` override) and can be overridden per-invocation with `--url` for local worker development.
