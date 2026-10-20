/**
 * Env vars that point an MCP client's config somewhere other than the
 * (test-redirected) homedir. Cleared by `src/test/preload.ts` before any test
 * loads, and per test by `useCleanMcpClientEnv`. Add any new
 * config-relocating var a client honors here.
 */
export const MCP_CLIENT_ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
  "HERMES_HOME",
  "HERMES_DATA_DIR_SUFFIX",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
] as const;
