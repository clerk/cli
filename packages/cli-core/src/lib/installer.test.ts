import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  isHomebrewPath,
  globalInstallCommand,
  findClerkOnPath,
  findRunningInstallIndex,
  ownerOfBinary,
  isAsdfShimPath,
  asdfPluginFromPath,
  resolveAsdfShim,
} from "./installer.ts";

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

  // Windows path normalization is only exercised when process.platform is
  // "win32" — the helper no-ops on POSIX. The CI matrix runs Windows
  // separately, so these cases guard against regressions there.
  test("matches win32 extended-length realpath against plain install dir (windows-only)", () => {
    if (process.platform !== "win32") return;
    const win = { npm: "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules" } as const;
    // Bun's realpath can prepend \\?\ for deep trees; install dir may not have it.
    expect(
      ownerOfBinary(
        "\\\\?\\C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@clerk\\cli-win32-x64\\bin\\clerk.exe",
        win,
      ),
    ).toBe("npm");
  });

  test("matches win32 UNC realpath against install dir (windows-only)", () => {
    if (process.platform !== "win32") return;
    const win = { npm: "\\\\server\\share\\npm\\node_modules" } as const;
    // \\?\UNC\server\share\... is the extended-length form of \\server\share\...
    expect(
      ownerOfBinary(
        "\\\\?\\UNC\\server\\share\\npm\\node_modules\\@clerk\\cli-win32-x64\\bin\\clerk.exe",
        win,
      ),
    ).toBe("npm");
  });
});

// ── findRunningInstallIndex ─────────────────────────────────────────────────

describe("findRunningInstallIndex", () => {
  const dirs = {
    npm: "/home/u/.asdf/installs/nodejs/22.16.0/lib/node_modules",
    bun: "/home/u/.bun/install/global/node_modules",
  } as const;

  // Platform binaries the Node shim spawns (what process.execPath resolves to
  // inside the compiled CLI).
  const bunPlatformBin = "/home/u/.bun/install/global/node_modules/@clerk/cli-linux-x64/bin/clerk";
  const npmPlatformBin =
    "/home/u/.asdf/installs/nodejs/22.16.0/lib/node_modules/@clerk/cli-linux-x64/bin/clerk";

  // PATH candidates after realpath + asdf resolution (sibling shims in the
  // same install tree as the platform binary).
  const bunCandidate = {
    resolvedPath: "/home/u/.bun/install/global/node_modules/clerk/bin/clerk",
  };
  const npmCandidate = {
    resolvedPath: "/home/u/.asdf/installs/nodejs/22.16.0/lib/node_modules/clerk/bin/clerk",
  };

  test("returns index of candidate owned by same installer as execPath", () => {
    // Reproduces the reported bug: asdf-npm first on PATH, user ran bun's
    // install. The running install must win over PATH order.
    const candidates = [npmCandidate, bunCandidate];
    expect(findRunningInstallIndex(candidates, bunPlatformBin, dirs)).toBe(1);
  });

  test("picks the right install when running is npm and PATH puts bun first", () => {
    // Mirror case of the above, covering the other direction.
    const candidates = [bunCandidate, npmCandidate];
    expect(findRunningInstallIndex(candidates, npmPlatformBin, dirs)).toBe(1);
  });

  test("returns 0 when the running install is already first on PATH", () => {
    const candidates = [bunCandidate, npmCandidate];
    expect(findRunningInstallIndex(candidates, bunPlatformBin, dirs)).toBe(0);
  });

  test("returns -1 when execPath is outside every known installer dir", () => {
    // install.sh-style standalone binary: not owned by any PM, so there is
    // no "running install" to match against — caller falls back to PATH order.
    const candidates = [bunCandidate, npmCandidate];
    expect(findRunningInstallIndex(candidates, "/usr/local/bin/clerk", dirs)).toBe(-1);
  });

  test("returns -1 when candidates is empty", () => {
    expect(findRunningInstallIndex([], bunPlatformBin, dirs)).toBe(-1);
  });

  test("returns -1 when the running installer is not among candidates", () => {
    // Running install has owner, but none of the PATH candidates share it.
    // Caller should fall through to PATH-first order rather than misfire.
    const candidates = [npmCandidate];
    expect(findRunningInstallIndex(candidates, bunPlatformBin, dirs)).toBe(-1);
  });

  test("matches Homebrew execPath against a Homebrew candidate", () => {
    const candidates = [
      { resolvedPath: "/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk" },
      npmCandidate,
    ];
    expect(
      findRunningInstallIndex(candidates, "/opt/homebrew/Cellar/clerk/1.0.0/bin/clerk", dirs),
    ).toBe(0);
  });

  test("returns -1 when execPath is under an inactive asdf-nodejs version", () => {
    // installDirs.npm points at the currently-active nodejs version (from
    // `npm root -g`). A binary under a *different* asdf-nodejs install (e.g.
    // the user invoked clerk from a shell that had v20 active, while the
    // current shell has v22 active) doesn't start with the active dir, so
    // ownerOfBinary returns null and the helper safely falls back to PATH
    // order rather than mismatching against the active version's clerk.
    const candidates = [bunCandidate, npmCandidate];
    const inactiveNodeExec =
      "/home/u/.asdf/installs/nodejs/20.0.0/lib/node_modules/@clerk/cli-linux-x64/bin/clerk";
    expect(findRunningInstallIndex(candidates, inactiveNodeExec, dirs)).toBe(-1);
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
