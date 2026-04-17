import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  detectFromUserAgent,
  isHomebrewPath,
  globalInstallCommand,
  detectInstaller,
  findClerkOnPath,
  ownerOfBinary,
  isAsdfShimPath,
  asdfPluginFromPath,
  resolveAsdfShim,
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

describe("detectInstaller", () => {
  let savedUA: string | undefined;
  let savedExecPath: string;

  beforeEach(() => {
    savedUA = process.env.npm_config_user_agent;
    savedExecPath = process.execPath;
    delete process.env.npm_config_user_agent;
  });

  afterEach(() => {
    if (savedUA === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = savedUA;
    }
    Object.defineProperty(process, "execPath", { value: savedExecPath, writable: true });
  });

  function setExecPath(path: string) {
    Object.defineProperty(process, "execPath", { value: path, writable: true });
  }

  // ── Stage 1: npm_config_user_agent ─────────────────────────────────────

  test("stage 1: returns bun when npm_config_user_agent starts with bun/", async () => {
    process.env.npm_config_user_agent = "bun/1.3.9";
    expect(await detectInstaller()).toBe("bun");
  });

  test("stage 1: returns pnpm when npm_config_user_agent starts with pnpm/", async () => {
    process.env.npm_config_user_agent = "pnpm/8.15.0 npm/? node/v22.0.0";
    expect(await detectInstaller()).toBe("pnpm");
  });

  test("stage 1: returns yarn when npm_config_user_agent starts with yarn/", async () => {
    process.env.npm_config_user_agent = "yarn/3.6.0 npm/? node/v22.0.0";
    expect(await detectInstaller()).toBe("yarn");
  });

  test("stage 1: returns npm when npm_config_user_agent starts with npm/", async () => {
    process.env.npm_config_user_agent = "npm/10.5.0 node/v22.0.0 darwin arm64";
    expect(await detectInstaller()).toBe("npm");
  });

  test("stage 1: takes priority over Homebrew execPath", async () => {
    process.env.npm_config_user_agent = "npm/10.5.0";
    setExecPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk");
    expect(await detectInstaller()).toBe("npm");
  });

  // ── Stage 2a: Homebrew ─────────────────────────────────────────────────

  test("stage 2a: detects Homebrew from Apple Silicon Cellar path", async () => {
    setExecPath("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk");
    expect(await detectInstaller()).toBe("homebrew");
  });

  test("stage 2a: detects Homebrew from Intel Cellar path", async () => {
    setExecPath("/usr/local/Cellar/clerk/2.0.0/bin/clerk");
    expect(await detectInstaller()).toBe("homebrew");
  });

  test("stage 2a: detects Linuxbrew from Cellar path", async () => {
    setExecPath("/home/linuxbrew/.linuxbrew/Cellar/clerk/1.0.0/bin/clerk");
    expect(await detectInstaller()).toBe("homebrew");
  });

  // ── Stage 2b: PM prefix matching ───────────────────────────────────────

  test("stage 2b: detects npm when execPath is under npm global prefix", async () => {
    const result = Bun.spawnSync(["npm", "prefix", "-g"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return;
    const prefix = new TextDecoder().decode(result.stdout).trim();
    if (!prefix) return;

    setExecPath(`${prefix}/lib/node_modules/@clerk/cli-darwin-arm64/bin/clerk`);
    expect(await detectInstaller()).toBe("npm");
  });

  // ── Stage 3: Fallback ─────────────────────────────────────────────────

  test("stage 3: falls back to npm for unrecognized execPath", async () => {
    setExecPath("/some/totally/unknown/path/to/clerk");
    expect(await detectInstaller()).toBe("npm");
  });
});

// ── ownerOfBinary ────────────────────────────────────────────────────────────

describe("ownerOfBinary", () => {
  const dirs = {
    npm: "/opt/homebrew/lib/node_modules",
    pnpm: "/Users/x/Library/pnpm/global/5/node_modules",
    yarn: "/Users/x/.config/yarn/global/node_modules",
    bun: "/Users/x/.bun/install/global/node_modules",
  } as const;

  test("returns homebrew for Cellar paths regardless of installDirs", () => {
    expect(ownerOfBinary("/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk", dirs)).toBe("homebrew");
  });

  test("returns bun for paths under bun's install dir", () => {
    expect(
      ownerOfBinary(
        "/Users/x/.bun/install/global/node_modules/@clerk/cli-darwin-arm64/bin/clerk",
        dirs,
      ),
    ).toBe("bun");
  });

  test("returns npm for paths under npm prefix", () => {
    expect(
      ownerOfBinary("/opt/homebrew/lib/node_modules/@clerk/cli-darwin-arm64/bin/clerk", dirs),
    ).toBe("npm");
  });

  test("returns pnpm for paths under pnpm's global dir", () => {
    expect(
      ownerOfBinary(
        "/Users/x/Library/pnpm/global/5/node_modules/@clerk/cli-darwin-arm64/bin/clerk",
        dirs,
      ),
    ).toBe("pnpm");
  });

  test("returns yarn for paths under yarn's global dir", () => {
    expect(
      ownerOfBinary(
        "/Users/x/.config/yarn/global/node_modules/@clerk/cli-darwin-arm64/bin/clerk",
        dirs,
      ),
    ).toBe("yarn");
  });

  test("returns null for install.sh standalone binaries", () => {
    expect(ownerOfBinary("/usr/local/bin/clerk", dirs)).toBe(null);
  });

  test("returns null when no installers are present on the system", () => {
    expect(
      ownerOfBinary(
        "/Users/x/.bun/install/global/node_modules/@clerk/cli-darwin-arm64/bin/clerk",
        {},
      ),
    ).toBe(null);
  });

  test("trailing separator prevents /a/b matching /a/bother", () => {
    // "/a/b" must not match a binary at "/a/bother/clerk".
    const nested = { npm: "/a/b" } as const;
    expect(ownerOfBinary("/a/bother/clerk", nested)).toBe(null);
    expect(ownerOfBinary("/a/b/clerk", nested)).toBe("npm");
  });

  test("longest match wins when dirs nest", () => {
    const nested = {
      npm: "/home/x/.asdf/installs/nodejs/22/lib/node_modules",
      bun: "/home/x/.asdf/installs/nodejs/22/lib/node_modules/.bun-shim",
    } as const;
    expect(
      ownerOfBinary(
        "/home/x/.asdf/installs/nodejs/22/lib/node_modules/.bun-shim/@clerk/cli-linux-x64/bin/clerk",
        nested,
      ),
    ).toBe("bun");
  });
});

// ── findClerkOnPath ──────────────────────────────────────────────────────────

describe("findClerkOnPath", () => {
  let sandbox: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    // realpath so symlinks like macOS's /var -> /private/var are resolved
    // upfront; findClerkOnPath also realpaths, so the comparison matches.
    sandbox = await realpath(await mkdtemp(join(tmpdir(), "clerk-path-test-")));
    savedPath = process.env.PATH;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(sandbox, { recursive: true, force: true });
  });

  test("returns empty array when PATH has no clerk", async () => {
    process.env.PATH = sandbox;
    expect(await findClerkOnPath()).toEqual([]);
  });

  test("finds a single executable clerk on PATH", async () => {
    const bin = join(sandbox, "clerk");
    await writeFile(bin, "#!/bin/sh\necho fake");
    await chmod(bin, 0o755);
    process.env.PATH = sandbox;
    const found = await findClerkOnPath();
    expect(found).toEqual([bin]);
  });

  test("skips non-executable files on POSIX", async () => {
    if (process.platform === "win32") return;
    const bin = join(sandbox, "clerk");
    await writeFile(bin, "#!/bin/sh\necho fake");
    await chmod(bin, 0o644); // no execute bit
    process.env.PATH = sandbox;
    expect(await findClerkOnPath()).toEqual([]);
  });

  test("skips directories named clerk", async () => {
    await mkdir(join(sandbox, "clerk"));
    process.env.PATH = sandbox;
    expect(await findClerkOnPath()).toEqual([]);
  });

  test("preserves PATH order across multiple hits", async () => {
    const dirA = join(sandbox, "a");
    const dirB = join(sandbox, "b");
    await mkdir(dirA);
    await mkdir(dirB);
    const aBin = join(dirA, "clerk");
    const bBin = join(dirB, "clerk");
    await writeFile(aBin, "#!/bin/sh\necho a");
    await writeFile(bBin, "#!/bin/sh\necho b");
    await chmod(aBin, 0o755);
    await chmod(bBin, 0o755);
    process.env.PATH = [dirA, dirB].join(delimiter);
    expect(await findClerkOnPath()).toEqual([aBin, bBin]);
    // Reversed PATH should reverse the order too.
    process.env.PATH = [dirB, dirA].join(delimiter);
    expect(await findClerkOnPath()).toEqual([bBin, aBin]);
  });

  test("dedupes by realpath when two PATH entries resolve to the same file", async () => {
    if (process.platform === "win32") return; // skip symlink test on win32
    const real = join(sandbox, "real");
    const link = join(sandbox, "link");
    await mkdir(real);
    await symlink(real, link);
    const bin = join(real, "clerk");
    await writeFile(bin, "#!/bin/sh\necho fake");
    await chmod(bin, 0o755);
    process.env.PATH = [real, link].join(delimiter);
    const found = await findClerkOnPath();
    expect(found.length).toBe(1);
    expect(found[0]).toBe(bin);
  });

  test("ignores empty PATH entries (:: as CWD)", async () => {
    const bin = join(sandbox, "clerk");
    await writeFile(bin, "#!/bin/sh\necho fake");
    await chmod(bin, 0o755);
    process.env.PATH = `${sandbox}${delimiter}${delimiter}`;
    expect(await findClerkOnPath()).toEqual([bin]);
  });
});

// ── asdf helpers ─────────────────────────────────────────────────────────────

describe("isAsdfShimPath", () => {
  let savedDataDir: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.ASDF_DATA_DIR;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.ASDF_DATA_DIR;
    else process.env.ASDF_DATA_DIR = savedDataDir;
  });

  test("matches paths under the default ~/.asdf/shims directory", () => {
    delete process.env.ASDF_DATA_DIR;
    const home = process.env.HOME ?? "";
    expect(isAsdfShimPath(`${home}/.asdf/shims/clerk`)).toBe(true);
  });

  test("matches paths under an ASDF_DATA_DIR override", () => {
    process.env.ASDF_DATA_DIR = "/opt/asdf-data";
    expect(isAsdfShimPath("/opt/asdf-data/shims/clerk")).toBe(true);
  });

  test("rejects non-shim paths (including trailing-separator-adjacent names)", () => {
    process.env.ASDF_DATA_DIR = "/opt/asdf-data";
    expect(isAsdfShimPath("/opt/asdf-data/installs/nodejs/22/bin/clerk")).toBe(false);
    expect(isAsdfShimPath("/usr/local/bin/clerk")).toBe(false);
    expect(isAsdfShimPath("/opt/asdf-data/shimsxyz/clerk")).toBe(false);
  });
});

describe("asdfPluginFromPath", () => {
  let savedDataDir: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.ASDF_DATA_DIR;
    process.env.ASDF_DATA_DIR = "/opt/asdf-data";
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.ASDF_DATA_DIR;
    else process.env.ASDF_DATA_DIR = savedDataDir;
  });

  test("extracts the plugin name from a nodejs installs path", () => {
    expect(
      asdfPluginFromPath("/opt/asdf-data/installs/nodejs/22.16.0/lib/node_modules/clerk/bin/clerk"),
    ).toBe("nodejs");
  });

  test("returns null for paths outside the installs tree", () => {
    expect(asdfPluginFromPath("/opt/asdf-data/shims/clerk")).toBe(null);
    expect(asdfPluginFromPath("/usr/local/bin/clerk")).toBe(null);
  });

  test("returns null when the installs path has no plugin segment", () => {
    expect(asdfPluginFromPath("/opt/asdf-data/installs")).toBe(null);
    expect(asdfPluginFromPath("/opt/asdf-data/installs/")).toBe(null);
  });
});

describe("resolveAsdfShim", () => {
  let savedDataDir: string | undefined;

  beforeEach(() => {
    savedDataDir = process.env.ASDF_DATA_DIR;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.ASDF_DATA_DIR;
    else process.env.ASDF_DATA_DIR = savedDataDir;
  });

  test("returns non-shim paths unchanged", async () => {
    process.env.ASDF_DATA_DIR = "/opt/asdf-data";
    expect(await resolveAsdfShim("/usr/local/bin/clerk")).toBe("/usr/local/bin/clerk");
    expect(await resolveAsdfShim("/opt/homebrew/bin/clerk")).toBe("/opt/homebrew/bin/clerk");
  });

  test("returns shim path unchanged when `asdf which` fails", async () => {
    process.env.ASDF_DATA_DIR = "/nonexistent/asdf-sandbox";
    const shim = "/nonexistent/asdf-sandbox/shims/definitely-not-a-real-binary-xyzzy";
    expect(await resolveAsdfShim(shim)).toBe(shim);
  });
});
