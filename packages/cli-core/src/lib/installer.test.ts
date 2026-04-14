import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  detectFromUserAgent,
  isHomebrewPath,
  globalInstallCommand,
  detectInstaller,
} from "./installer.ts";

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

// ── detectInstaller ──────────────────────────────────────────────────────────

// Bun.which is a native global. We patch it directly the same way
// runners.test.ts patches Bun.which — wrapped in try/catch because some
// runtimes mark globals as non-writable.
const origWhich = Bun.which;

function mockWhich(returnValue: string | null) {
  try {
    (Bun as unknown as { which: () => string | null }).which = () => returnValue;
  } catch {
    // Bun.which may not be writable on some runtimes
  }
}

function restoreWhich() {
  try {
    (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
  } catch {
    // Bun.which may not be writable on some runtimes
  }
}

describe("detectInstaller", () => {
  let savedUA: string | undefined;
  let savedExecPath: string;

  beforeEach(() => {
    savedUA = process.env.npm_config_user_agent;
    savedExecPath = process.execPath;
    // Clear UA so tests control each stage explicitly
    delete process.env.npm_config_user_agent;
  });

  afterEach(() => {
    if (savedUA === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = savedUA;
    }
    Object.defineProperty(process, "execPath", { value: savedExecPath, writable: true });
    restoreWhich();
  });

  function setExecPath(path: string) {
    Object.defineProperty(process, "execPath", { value: path, writable: true });
  }

  // ── Stage 1: npm_config_user_agent ─────────────────────────────────────

  test("stage 1: returns bun when npm_config_user_agent starts with bun/", async () => {
    process.env.npm_config_user_agent = "bun/1.3.9";
    mockWhich("/some/bin/clerk");
    const info = await detectInstaller();
    expect(info.installer).toBe("bun");
    expect(info.binPath).toBe("/some/bin/clerk");
  });

  test("stage 1: returns pnpm when npm_config_user_agent starts with pnpm/", async () => {
    process.env.npm_config_user_agent = "pnpm/8.15.0 npm/? node/v22.0.0";
    mockWhich(null);
    const info = await detectInstaller();
    expect(info.installer).toBe("pnpm");
  });

  test("stage 1: returns yarn when npm_config_user_agent starts with yarn/", async () => {
    process.env.npm_config_user_agent = "yarn/3.6.0 npm/? node/v22.0.0";
    mockWhich(null);
    const info = await detectInstaller();
    expect(info.installer).toBe("yarn");
  });

  test("stage 1: returns npm when npm_config_user_agent starts with npm/", async () => {
    process.env.npm_config_user_agent = "npm/10.5.0 node/v22.0.0 darwin arm64";
    mockWhich(null);
    const info = await detectInstaller();
    expect(info.installer).toBe("npm");
  });

  test("stage 1: takes priority over Homebrew execPath", async () => {
    process.env.npm_config_user_agent = "npm/10.5.0";
    setExecPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk");
    mockWhich("/opt/homebrew/bin/clerk");
    const info = await detectInstaller();
    // UA wins over Homebrew detection
    expect(info.installer).toBe("npm");
  });

  // ── Stage 2a: Homebrew ─────────────────────────────────────────────────

  test("stage 2a: detects Homebrew from Apple Silicon Cellar path", async () => {
    setExecPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk");
    mockWhich("/opt/homebrew/bin/clerk");
    const info = await detectInstaller();
    expect(info.installer).toBe("homebrew");
    expect(info.binPath).toBe("/opt/homebrew/bin/clerk");
  });

  test("stage 2a: detects Homebrew from Intel Cellar path", async () => {
    setExecPath("/usr/local/Cellar/clerk/2.0.0/bin/clerk");
    mockWhich("/usr/local/bin/clerk");
    const info = await detectInstaller();
    expect(info.installer).toBe("homebrew");
  });

  test("stage 2a: detects Linuxbrew from Cellar path", async () => {
    setExecPath("/home/linuxbrew/.linuxbrew/Cellar/clerk/1.0.0/bin/clerk");
    mockWhich("/home/linuxbrew/.linuxbrew/bin/clerk");
    const info = await detectInstaller();
    expect(info.installer).toBe("homebrew");
  });

  // ── Stage 2b: PM prefix matching ───────────────────────────────────────

  test("stage 2b: detects npm when execPath is under npm global prefix", async () => {
    // Query the real npm prefix on this machine
    const result = Bun.spawnSync(["npm", "prefix", "-g"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return; // skip if npm unavailable
    const prefix = new TextDecoder().decode(result.stdout).trim();
    if (!prefix) return;

    setExecPath(`${prefix}/lib/node_modules/@clerk/cli-darwin-arm64/bin/clerk`);
    mockWhich(`${prefix}/bin/clerk`);
    const info = await detectInstaller();
    expect(info.installer).toBe("npm");
  });

  // ── Stage 3: Fallback ─────────────────────────────────────────────────

  test("stage 3: falls back to npm for unrecognized execPath", async () => {
    setExecPath("/some/totally/unknown/path/to/clerk");
    mockWhich(null);
    const info = await detectInstaller();
    expect(info.installer).toBe("npm");
    expect(info.binPath).toBeNull();
  });

  test("stage 3: falls back to npm for unrecognized execPath with binPath", async () => {
    setExecPath("/opt/custom-install/clerk");
    mockWhich("/opt/custom-install/clerk");
    const info = await detectInstaller();
    expect(info.installer).toBe("npm");
    expect(info.binPath).toBe("/opt/custom-install/clerk");
  });

  // ── binPath ────────────────────────────────────────────────────────────

  test("binPath comes from Bun.which regardless of installer", async () => {
    process.env.npm_config_user_agent = "bun/1.3.9";
    mockWhich("/custom/path/to/clerk");
    const info = await detectInstaller();
    expect(info.binPath).toBe("/custom/path/to/clerk");
  });

  test("binPath is null when Bun.which returns null", async () => {
    setExecPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk");
    mockWhich(null);
    const info = await detectInstaller();
    expect(info.installer).toBe("homebrew");
    expect(info.binPath).toBeNull();
  });
});
