/**
 * Cross-platform path + filesystem helpers for MCP client integrations.
 *
 * We deliberately avoid OS-specific layout (no XDG, no AppData) — every
 * documented client config path is rooted at `~/.<tool>/` regardless of
 * platform, so a single homedir join is enough.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function projectPath(cwd: string, ...segments: string[]): string {
  return join(cwd, ...segments);
}

export function userPath(...segments: string[]): string {
  return join(homedir(), ...segments);
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
