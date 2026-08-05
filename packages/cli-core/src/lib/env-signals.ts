/**
 * Anonymous environment signals for CLI telemetry (GROW-1200).
 * Detection tables ported from stripe-cli's pkg/useragent (their field/value
 * enums are the reference the ticket's proposed scope was written against).
 *
 * All functions take an injected env so tests never depend on the ambient
 * environment (the dev machine may itself run inside an AI agent or tmux).
 */

export type EnvLike = Record<string, string | undefined>;

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

export function detectTerminalProgram(env: EnvLike): string {
  if (env.LC_TERMINAL) return env.LC_TERMINAL;
  if (env.WARP_CLIENT_VERSION) return "warp";
  if (env.WT_SESSION) return "windows_terminal";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_LOG) return "alacritty";
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE) return "wezterm";
  if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  return env.TERM_PROGRAM ?? "";
}

/**
 * How the CLI binary was installed/invoked. The npm wrapper and package
 * runners leave `npm_*` vars in the child env; direct binary installs are
 * classified by executable path.
 */
export function detectInstallMethod(env: EnvLike, execPath: string): string {
  if (env.CLERK_INSTALL_METHOD) return env.CLERK_INSTALL_METHOD;

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
