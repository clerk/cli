/**
 * Cross-platform path + filesystem helpers for MCP client integrations.
 *
 * Most clients root their config at `~/.<tool>/` regardless of platform, so a
 * single homedir join is enough. VS Code is the exception — its user-level
 * config lives under the OS-specific app-support dir (see `vscodeUserDir`).
 */

import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function projectPath(cwd: string, ...segments: string[]): string {
  return join(cwd, ...segments);
}

export function userPath(...segments: string[]): string {
  return join(homedir(), ...segments);
}

/**
 * VS Code's per-user (global) config directory, where its `mcp.json` lives.
 * Unlike the other clients this is OS-specific: Application Support on macOS,
 * %APPDATA% on Windows, XDG config on Linux.
 */
export function vscodeUserDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User");
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Code", "User");
  }
}

/**
 * Returns true when *anything* exists at `path` — file, directory, symlink.
 * Detection only needs to know "did the user install this tool?", which is
 * adequately answered by "does the well-known config dir exist?". A regular
 * file at a directory path is impossible in practice for the tools we check.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
