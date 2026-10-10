---
"clerk": minor
---

Add fx (https://fx.sh) as a supported client for `clerk mcp install`, `list`, and `uninstall`. The Clerk MCP server is written to fx's user-global `~/.fx/mcp.json` as a direct Streamable HTTP entry (`{ "type": "http", "url": … }` under top-level `mcp`) — fx connects to the URL natively, so no `clerk mcp run` bridge is involved. Detected via the presence of `~/.fx/`; target it explicitly with `--client fx`.
