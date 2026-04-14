import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { detectFromUserAgent, isHomebrewPath, globalInstallCommand } from "./installer.ts";

// ── detectFromUserAgent ──────────────────────────────────────────────────────

describe("detectFromUserAgent", () => {
  let savedUA: string | undefined;

  beforeEach(() => {
    savedUA = process.env.npm_config_user_agent;
  });

  afterEach(() => {
    if (savedUA === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = savedUA;
    }
  });

  test("detects bun", () => {
    process.env.npm_config_user_agent = "bun/1.3.9";
    expect(detectFromUserAgent()).toBe("bun");
  });

  test("detects pnpm", () => {
    process.env.npm_config_user_agent = "pnpm/8.15.0 npm/? node/v22.0.0";
    expect(detectFromUserAgent()).toBe("pnpm");
  });

  test("detects yarn", () => {
    process.env.npm_config_user_agent = "yarn/3.6.0 npm/? node/v22.0.0";
    expect(detectFromUserAgent()).toBe("yarn");
  });

  test("detects npm", () => {
    process.env.npm_config_user_agent = "npm/10.5.0 node/v22.0.0 darwin arm64";
    expect(detectFromUserAgent()).toBe("npm");
  });

  test("returns null for empty string", () => {
    process.env.npm_config_user_agent = "";
    expect(detectFromUserAgent()).toBeNull();
  });

  test("returns null when unset", () => {
    delete process.env.npm_config_user_agent;
    expect(detectFromUserAgent()).toBeNull();
  });
});

// ── isHomebrewPath ───────────────────────────────────────────────────────────

describe("isHomebrewPath", () => {
  test("detects macOS Apple Silicon Cellar path", () => {
    expect(isHomebrewPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk")).toBe(true);
  });

  test("detects macOS Intel Cellar path", () => {
    expect(isHomebrewPath("/usr/local/Cellar/clerk/1.0.0/bin/clerk")).toBe(true);
  });

  test("detects Linuxbrew Cellar path", () => {
    expect(isHomebrewPath("/home/linuxbrew/.linuxbrew/Cellar/clerk/2.0.0/bin/clerk")).toBe(true);
  });

  test("detects macOS /private prefix (process.execPath resolves through it)", () => {
    expect(isHomebrewPath("/private/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk")).toBe(true);
  });

  test("rejects plain /usr/local/bin path", () => {
    expect(isHomebrewPath("/usr/local/bin/clerk")).toBe(false);
  });

  test("rejects npm node_modules path", () => {
    expect(isHomebrewPath("/usr/local/lib/node_modules/@clerk/cli-darwin-arm64/bin/clerk")).toBe(
      false,
    );
  });

  test("rejects bun global bin path", () => {
    expect(isHomebrewPath("/Users/user/.bun/bin/clerk")).toBe(false);
  });

  test("does not match unrelated Cellar paths", () => {
    expect(isHomebrewPath("/opt/homebrew/Cellar/node/22.0.0/bin/node")).toBe(false);
  });
});

// ── globalInstallCommand ─────────────────────────────────────────────────────

describe("globalInstallCommand", () => {
  test("npm", () => {
    expect(globalInstallCommand("npm", "clerk@2.0.0")).toBe("npm install -g clerk@2.0.0");
  });

  test("bun", () => {
    expect(globalInstallCommand("bun", "clerk@2.0.0")).toBe("bun add -g clerk@2.0.0");
  });

  test("pnpm", () => {
    expect(globalInstallCommand("pnpm", "clerk@2.0.0")).toBe("pnpm add -g clerk@2.0.0");
  });

  test("yarn", () => {
    expect(globalInstallCommand("yarn", "clerk@2.0.0")).toBe("yarn global add clerk@2.0.0");
  });

  test("homebrew ignores packageSpec", () => {
    expect(globalInstallCommand("homebrew", "clerk@2.0.0")).toBe("brew upgrade clerk");
  });
});
