/**
 * Cross-platform path + filesystem helpers for MCP client integrations.
 *
 * Most clients root their config at `~/.<tool>/` regardless of platform, so a
 * single homedir join is enough. VS Code is the exception — its user-level
 * config lives under the OS-specific app-support dir (see `vscodeUserDir`).
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function userPath(...segments: string[]): string {
  return join(homedir(), ...segments);
}

/**
 * Candidate VS Code user-config dirs in priority order. Linux has three: the
 * standard XDG location plus Flatpak and Snap sandboxes, which redirect config
 * under their own per-app trees. The first existing one wins; the standard XDG
 * path is the fallback for a fresh install.
 */
function vscodeUserDirCandidates(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA?.trim();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  switch (platform()) {
    case "win32":
      return [join(appData || join(home, "AppData", "Roaming"), "Code", "User")];
    case "darwin":
      return [join(home, "Library", "Application Support", "Code", "User")];
    default:
      return [
        join(xdgConfigHome || join(home, ".config"), "Code", "User"),
        join(home, ".var", "app", "com.visualstudio.code", "config", "Code", "User"),
        join(home, "snap", "code", "current", ".config", "Code", "User"),
      ];
  }
}

/**
 * VS Code's per-user (global) config directory, where its `mcp.json` lives.
 * Unlike the other clients this is OS-specific: Application Support on macOS,
 * %APPDATA% on Windows, XDG config (or a Flatpak/Snap sandbox) on Linux. Probed
 * synchronously so detection and the write path resolve to the same directory.
 */
export function vscodeUserDir(): string {
  const candidates = vscodeUserDirCandidates();
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
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
