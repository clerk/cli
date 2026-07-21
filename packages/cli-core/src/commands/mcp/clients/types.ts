/**
 * Shared types for MCP client integrations.
 *
 * Each supported MCP client (Claude Code, Cursor, GitHub Copilot, Windsurf,
 * Gemini, Codex, opencode, OpenClaw, Warp, Hermes) exposes an
 * {@link McpClient} that knows how to read, upsert, and remove the `clerk`
 * server entry in its own config file format.
 */

export type ClientId =
  | "claude"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "gemini"
  | "codex"
  | "opencode"
  | "openclaw"
  | "warp"
  | "hermes";

/**
 * Per-client manual setup instructions for the Clerk MCP server. Attached as
 * `docsUrl` to MCP errors so a user whose client we can't drive (missing CLI,
 * failing CLI, nothing detected) always has the manual path.
 */
export const MCP_DOCS_URL = "https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server";

/** All supported clients register at user (global) scope today. */
export type Scope = "user";

export interface McpServerEntry {
  /** Entry name (key under `mcpServers` / `servers`). Default: `clerk`. */
  name: string;
  /** Remote MCP endpoint. */
  url: string;
}

/**
 * Install always converges to the desired entry (overwriting whatever was
 * there), so success has a single state. Failures reject and are settled
 * per-client by the callers.
 */
export type UpsertResult = { client: ClientId; configPath: string; status: "installed" };

export interface RemoveResult {
  client: ClientId;
  configPath: string;
  removed: boolean;
}

export interface ListEntry {
  client: ClientId;
  configPath: string;
  name: string;
  url: string;
}

export interface McpClient {
  id: ClientId;
  displayName: string;
  scope: Scope;
  /**
   * What the user must do *after* the config is written for this client to
   * connect — typically reload the editor, and sign in if the server requires
   * it. Writing the file is not enough on its own, so `install` surfaces this
   * as a next step.
   */
  activation: string;
  configPath(cwd: string): string;
  /**
   * Is this client usable on this machine? File-backed clients check for their
   * well-known config dir; CLI-backed clients check for their binary on PATH
   * (a config dir without the CLI is not installable by us).
   */
  detect(cwd: string): Promise<boolean>;
  upsert(entry: McpServerEntry, cwd: string): Promise<UpsertResult>;
  remove(name: string, cwd: string): Promise<RemoveResult>;
  /** List `clerk`-flavored entries currently registered (those pointing at clerk.com URLs or named explicitly). */
  list(cwd: string): Promise<ListEntry[]>;
}
