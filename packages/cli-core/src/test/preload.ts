/**
 * Loaded before every test file (see the `bunfig.toml` at the repo root and in
 * `packages/cli-core`, since Bun only reads the one in the working directory).
 *
 * These env vars relocate the configs the MCP clients read and write
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `HERMES_HOME`,
 * `HERMES_DATA_DIR_SUFFIX`) or the base directories some of them resolve
 * under (`XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA`). A test that redirects
 * homedir but inherits a developer's own value would operate on their real
 * config files — including deleting them — so clear them all before any test
 * code runs. Tests that need one set it explicitly (see `useCleanMcpClientEnv`).
 */
import { MCP_CLIENT_ENV_VARS } from "./lib/mcp-client-env.ts";

for (const key of MCP_CLIENT_ENV_VARS) delete process.env[key];
