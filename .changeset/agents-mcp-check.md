---
"clerk": minor
---

Add `clerk agents mcp check [url]`, which reports whether your MCP server is set up for Clerk: the URL is registered as an MCP server, the audience claim and client registration are on, and its protected resource metadata is reachable and names the server and your instance. Each check is reported as pass or fail, and the command exits non-zero when one fails. It takes `--app`, `--instance` and `--json`, prints JSON in agent mode, changes nothing and sends no MCP request to the server.
