---
"clerk": minor
---

Add `clerk mcp install`, `list`, and `uninstall` to register the Clerk remote MCP server (`https://mcp.clerk.com/mcp`) in Claude Code, Cursor, VS Code, Windsurf, and Gemini. Entries are written to each client's user-global config (e.g. `~/.claude.json`, `~/.cursor/mcp.json`), so the server is available across every project regardless of the directory you run the CLI from. `clerk doctor` gains an MCP reachability check that probes the configured server via the MCP `initialize` handshake when an entry is installed. By default the commands target Clerk's hosted server, so `clerk mcp install` works with no flags. The URL resolves in order: `--url` > the `CLERK_MCP_URL` override (for local worker development) > the active env profile's new `mcpUrl` field > the hosted server.
