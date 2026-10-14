---
"clerk": major
---

Connect AI clients to the Clerk MCP server by URL and remove the `clerk mcp run` stdio bridge. Re-run `clerk mcp install` to replace entries installed by earlier versions; until then they fail to connect, and `clerk mcp list` and `clerk doctor` flag them as legacy.

- Every supported client now gets a native Streamable HTTP entry in its own config format and signs in to Clerk itself, so `clerk` no longer needs to be on the editor's `PATH`. Each client's next step says how to sign in, for example `codex mcp login clerk`.
- The server URL is saved when you install. After switching environments or changing `CLERK_MCP_URL`, re-run `clerk mcp install` to update existing entries.
- `clerk mcp install --json` results include `migrated: true` when a legacy bridge entry was replaced, and `clerk mcp list --json` entries include a `legacy` field.
- `clerk mcp install`, `list`, `uninstall`, and `clerk doctor` honor `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so Claude Code and Codex entries are read and written where those clients look for them.
