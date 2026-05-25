/**
 * Shared types for MCP client integrations.
 *
 * Each supported MCP client (Claude Code, Cursor, VS Code, Windsurf, Gemini)
 * exposes an {@link McpClient} that knows how to read, upsert, and remove
 * the `clerk` server entry in its own config file format.
 */

export type ClientId = "claude-code" | "cursor" | "vscode" | "windsurf" | "gemini";

/** Where the client config file lives relative to the user / project. */
export type Scope = "project" | "user";

export interface McpServerEntry {
  /** Entry name (key under `mcpServers` / `servers`). Default: `clerk`. */
  name: string;
  /** Remote MCP endpoint. */
  url: string;
}

export type DiffStatus = "added" | "updated" | "unchanged" | "skipped";

/**
 * `reason` is present iff the entry was skipped — the union makes the
 * "reason only on skip" contract a compile-time guarantee instead of a comment.
 */
export type UpsertResult =
  | { client: ClientId; configPath: string; status: Exclude<DiffStatus, "skipped"> }
  | { client: ClientId; configPath: string; status: "skipped"; reason: string };

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
  /** Where the entry would be written for the given cwd. */
  configPath(cwd: string): string;
  /** Heuristic: is this client installed for this user? */
  detect(cwd: string): Promise<boolean>;
  /** Add or update the `name` entry pointing at `url`. */
  upsert(entry: McpServerEntry, cwd: string, force: boolean): Promise<UpsertResult>;
  /** Remove the `name` entry. */
  remove(name: string, cwd: string): Promise<RemoveResult>;
  /** List `clerk`-flavored entries currently registered (those pointing at clerk.com URLs or named explicitly). */
  list(cwd: string): Promise<ListEntry[]>;
}
