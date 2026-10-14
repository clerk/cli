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
 * Claude Code's user config file. `$CLAUDE_CONFIG_DIR` relocates it from
 * `~/.claude.json` to `$CLAUDE_CONFIG_DIR/.claude.json`, and `claude mcp add`
 * writes there, so `list`/`doctor` must read the same file.
 */
export function claudeConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(configDir, ".claude.json") : userPath(".claude.json");
}

/**
 * Codex's config root: `$CODEX_HOME` when set, otherwise `~/.codex`. Codex
 * reads `config.toml` from here, so installs must write to the same place.
 */
export function codexHomePath(...segments: string[]): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, ...segments) : userPath(".codex", ...segments);
}

/**
 * Gemini CLI's user settings file. `$GEMINI_CLI_HOME` replaces the home
 * directory Gemini roots `.gemini/` under, and `gemini mcp add` writes there.
 */
export function geminiSettingsPath(): string {
  const geminiHome = process.env.GEMINI_CLI_HOME?.trim();
  return join(geminiHome || homedir(), ".gemini", "settings.json");
}

/**
 * Hermes runs `$HERMES_HOME` through Python's `expandvars` then `expanduser`:
 * `$NAME`/`${NAME}` (and `%NAME%` on Windows) take their env value, unknown
 * variables stay literal, then a leading `~` becomes the home directory.
 */
function expandHermesHome(path: string): string {
  const pattern =
    platform() === "win32" ? /\$(\w+)|\$\{([^}]*)\}|%([^%]+)%/g : /\$(\w+)|\$\{([^}]*)\}/g;
  const expanded = path.replace(
    pattern,
    (match, bare?: string, braced?: string, percent?: string) =>
      process.env[bare ?? braced ?? percent ?? ""] ?? match,
  );
  return expanded === "~" || expanded.startsWith("~/")
    ? join(homedir(), expanded.slice(1))
    : expanded;
}

/**
 * Hermes' config root: `$HERMES_HOME` (expanded as Hermes expands it) when
 * set, otherwise the platform default — `%LOCALAPPDATA%\hermes` on Windows,
 * `~/.hermes` elsewhere — with `$HERMES_DATA_DIR_SUFFIX` appended to the
 * directory name.
 */
export function hermesHomePath(...segments: string[]): string {
  const hermesHome = process.env.HERMES_HOME?.trim();
  if (hermesHome) return join(expandHermesHome(hermesHome), ...segments);
  const suffix = process.env.HERMES_DATA_DIR_SUFFIX ?? "";
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return join(
      localAppData || join(homedir(), "AppData", "Local"),
      `hermes${suffix}`,
      ...segments,
    );
  }
  return userPath(`.hermes${suffix}`, ...segments);
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
 * XDG-style user config root: `$XDG_CONFIG_HOME` (or `~/.config`) on
 * macOS/Linux, `%APPDATA%` on Windows. opencode follows this convention on
 * every platform (no Application Support dir on macOS).
 */
export function xdgConfigPath(...segments: string[]): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(appData || join(homedir(), "AppData", "Roaming"), ...segments);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdgConfigHome || join(homedir(), ".config"), ...segments);
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
