---
"clerk": minor
---

Add `clerk agents mcp configure <url>`, which registers your own MCP server with Clerk: it adds the URL as an OAuth resource on the instance and, for the instance's first MCP server, turns on the audience claim and client ID metadata documents. It takes `--app`, `--instance` and `--json`, prints JSON in agent mode, and never changes dynamic client registration, PKCE or consent. `clerk mcp` is unchanged.
