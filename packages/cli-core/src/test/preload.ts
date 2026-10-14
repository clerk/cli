/**
 * Loaded before every test file (see the root `bunfig.toml`).
 *
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` relocate the Claude Code and Codex
 * configs the MCP clients read and write. A test that redirects homedir but
 * inherits a developer's own value would operate on their real config files,
 * including deleting them, so clear both before any test code runs. Tests that
 * need them set them explicitly (see `useCleanMcpClientEnv`).
 */
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
