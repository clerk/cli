import { describe, expect, test } from "bun:test";
import {
  detectAiAgent,
  detectInScreen,
  detectInstallMethod,
  detectInTmux,
  detectTerminalProgram,
} from "./env-signals.ts";

describe("detectAiAgent", () => {
  test.each([
    [{ ANTIGRAVITY_CLI_ALIAS: "1" }, "antigravity"],
    [{ CLAUDECODE: "1" }, "claude_code"],
    [{ CLINE_ACTIVE: "true" }, "cline"],
    [{ CODEX_SANDBOX: "1" }, "codex_cli"],
    [{ CODEX_THREAD_ID: "abc" }, "codex_cli"],
    [{ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, "codex_cli"],
    [{ CODEX_CI: "1" }, "codex_cli"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ GEMINI_CLI: "1" }, "gemini_cli"],
    [{ OPENCODE: "1" }, "open_code"],
    [{ OPENCLAW_SHELL: "1" }, "openclaw"],
  ])("detects %o as %s", (env, expected) => {
    expect(detectAiAgent(env)).toBe(expected);
  });

  test("returns empty string when nothing is set", () => {
    expect(detectAiAgent({})).toBe("");
  });

  test("ignores empty-string values", () => {
    expect(detectAiAgent({ CLAUDECODE: "" })).toBe("");
  });
});

describe("detectTerminalProgram", () => {
  test("LC_TERMINAL wins and is slugged", () => {
    expect(detectTerminalProgram({ LC_TERMINAL: "iTerm2", TERM_PROGRAM: "Apple_Terminal" })).toBe(
      "iterm2",
    );
  });

  test("fallback values are slugged and capped, never verbatim", () => {
    expect(detectTerminalProgram({ TERM_PROGRAM: "Apple_Terminal" })).toBe("apple_terminal");
    expect(detectTerminalProgram({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm.app");
    expect(detectTerminalProgram({ TERM_PROGRAM: "/Users/x/secret stuff!" })).toBe(
      "usersxsecretstuff",
    );
    expect(detectTerminalProgram({ LC_TERMINAL: "x".repeat(100) })).toHaveLength(32);
  });

  test.each([
    [{ WARP_CLIENT_VERSION: "1" }, "warp"],
    [{ WT_SESSION: "guid" }, "windows_terminal"],
    [{ KITTY_WINDOW_ID: "1" }, "kitty"],
    [{ ALACRITTY_WINDOW_ID: "1" }, "alacritty"],
    [{ ALACRITTY_LOG: "/tmp/x" }, "alacritty"],
    [{ WEZTERM_EXECUTABLE: "/bin/wezterm" }, "wezterm"],
    [{ WEZTERM_PANE: "0" }, "wezterm"],
    [{ GHOSTTY_RESOURCES_DIR: "/x" }, "ghostty"],
  ])("detects %o as %s", (env, expected) => {
    expect(detectTerminalProgram(env)).toBe(expected);
  });

  test("falls back to TERM_PROGRAM verbatim, then empty string", () => {
    expect(detectTerminalProgram({ TERM_PROGRAM: "vscode" })).toBe("vscode");
    expect(detectTerminalProgram({})).toBe("");
  });
});

describe("detectInstallMethod", () => {
  const noEnv = {};

  test("CLERK_INSTALL_METHOD override wins for known values only", () => {
    expect(detectInstallMethod({ CLERK_INSTALL_METHOD: "homebrew" }, "/anything")).toBe("homebrew");
  });

  test("unknown CLERK_INSTALL_METHOD values are ignored, not forwarded", () => {
    expect(detectInstallMethod({ CLERK_INSTALL_METHOD: "/tmp/evil" }, "/usr/local/bin/clerk")).toBe(
      "unknown",
    );
    // Falls through to normal detection instead of trusting the override.
    expect(
      detectInstallMethod(
        { CLERK_INSTALL_METHOD: "scoop" },
        "/opt/homebrew/Cellar/clerk/bin/clerk",
      ),
    ).toBe("homebrew");
  });

  test.each([
    ["/opt/homebrew/Cellar/clerk/1.0/bin/clerk", "homebrew"],
    ["/home/linuxbrew/.linuxbrew/bin/clerk", "homebrew"],
    ["/Users/x/.npm/_npx/abc123/node_modules/@clerk/cli-darwin-arm64/bin/clerk", "npx"],
    ["/private/tmp/bunx-501-clerk@latest/node_modules/.bin/clerk", "bunx"],
  ])("classifies execPath %s as %s", (execPath, expected) => {
    expect(detectInstallMethod(noEnv, execPath)).toBe(expected);
  });

  test("windows-style homebrew-less path with backslashes and node_modules is npm_global", () => {
    expect(
      detectInstallMethod(
        noEnv,
        "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@clerk\\cli-win32-x64\\bin\\clerk.exe",
      ),
    ).toBe("npm_global");
  });

  test("npm_lifecycle_event means a package script", () => {
    expect(
      detectInstallMethod({ npm_lifecycle_event: "dev" }, "/repo/node_modules/.bin/clerk"),
    ).toBe("npm_run");
  });

  test("npm_command=exec means npx", () => {
    expect(detectInstallMethod({ npm_command: "exec" }, "/somewhere/clerk")).toBe("npx");
  });

  test("bun user agent without lifecycle event means bunx", () => {
    expect(
      detectInstallMethod(
        { npm_config_user_agent: "bun/1.3.0 npm/? node/v24" },
        "/somewhere/clerk",
      ),
    ).toBe("bunx");
  });

  test("bare node_modules path means npm_global", () => {
    expect(
      detectInstallMethod(noEnv, "/usr/local/lib/node_modules/@clerk/cli-linux-x64/bin/clerk"),
    ).toBe("npm_global");
  });

  test("anything else is unknown", () => {
    expect(detectInstallMethod(noEnv, "/usr/local/bin/clerk")).toBe("unknown");
  });
});

describe("tmux / screen", () => {
  test("detects tmux via TMUX and screen via STY", () => {
    expect(detectInTmux({ TMUX: "/tmp/tmux-1000/default" })).toBe(true);
    expect(detectInTmux({})).toBe(false);
    expect(detectInScreen({ STY: "1234.pts-0" })).toBe(true);
    expect(detectInScreen({})).toBe(false);
  });
});
