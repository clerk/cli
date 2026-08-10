/**
 * Environment signals for CLI telemetry: which AI agent, terminal, and
 * install method a run came from. The returned strings are analytics keys —
 * renaming one breaks downstream queries.
 *
 * All functions take an injected env so tests never depend on the ambient
 * environment (the dev machine may itself run inside an AI agent or tmux).
 */

export type EnvLike = Record<string, string | undefined>;

// Truthiness (not equality) is deliberate: harnesses use different marker
// values — gemini/opencode set "1", cline sets "true", openclaw sets a mode
// string like "tui-local".
export function detectAiAgent(env: EnvLike): string {
  if (env.ANTIGRAVITY_CLI_ALIAS) return "antigravity";
  if (env.CLAUDECODE) return "claude_code";
  if (env.CLINE_ACTIVE) return "cline";
  if (
    env.CODEX_SANDBOX ||
    env.CODEX_THREAD_ID ||
    env.CODEX_SANDBOX_NETWORK_DISABLED ||
    env.CODEX_CI
  ) {
    return "codex_cli";
  }
  if (env.CURSOR_AGENT) return "cursor";
  if (env.GEMINI_CLI) return "gemini_cli";
  if (env.OPENCODE) return "open_code";
  if (env.OPENCLAW_SHELL) return "openclaw";
  return "";
}

// LC_TERMINAL / TERM_PROGRAM carry arbitrary text; every other signal here is
// a closed enum. Slug + cap them so no unbounded string reaches the payload.
const TERMINAL_SLUG_MAX = 32;
function slugTerminal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, TERMINAL_SLUG_MAX);
}

export function detectTerminalProgram(env: EnvLike): string {
  if (env.LC_TERMINAL) return slugTerminal(env.LC_TERMINAL);
  if (env.WARP_CLIENT_VERSION) return "warp";
  if (env.WT_SESSION) return "windows_terminal";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG) return "alacritty";
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE) return "wezterm";
  if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  return env.TERM_PROGRAM ? slugTerminal(env.TERM_PROGRAM) : "";
}

/**
 * How the CLI binary was installed/invoked. The npm wrapper and package
 * runners leave `npm_*` vars in the child env; direct binary installs are
 * classified by executable path.
 */
const INSTALL_METHODS = new Set(["npm_global", "npm_run", "npx", "bunx", "homebrew"]);

export function detectInstallMethod(env: EnvLike, execPath: string): string {
  // The override is only honored for known values — it must not become an
  // arbitrary-string channel into the payload.
  if (env.CLERK_INSTALL_METHOD && INSTALL_METHODS.has(env.CLERK_INSTALL_METHOD)) {
    return env.CLERK_INSTALL_METHOD;
  }

  const path = execPath.toLowerCase().replaceAll("\\", "/");
  if (path.includes("/cellar/") || path.includes("/homebrew/") || path.includes("/linuxbrew/")) {
    return "homebrew";
  }
  if (path.includes("/_npx/")) return "npx";
  if (path.includes("bunx-")) return "bunx";

  if (env.npm_lifecycle_event) return "npm_run";
  if (env.npm_command === "exec") return "npx";
  if (env.npm_config_user_agent?.startsWith("bun")) return "bunx";
  if (path.includes("/node_modules/")) return "npm_global";
  return "unknown";
}

export function detectInTmux(env: EnvLike): boolean {
  return Boolean(env.TMUX);
}

export function detectInScreen(env: EnvLike): boolean {
  return Boolean(env.STY);
}
