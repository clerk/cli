import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runFormatters } from "./format.ts";
import type { ProjectContext } from "./frameworks/types.js";

type SpawnArgs = readonly string[];

const origSpawn = Bun.spawn;
const origWhich = Bun.which;
const origSpawnSync = Bun.spawnSync;

type SpawnImpl = (
  cmd: SpawnArgs,
  opts?: { cwd?: string; stdout?: unknown; stderr?: unknown },
) => { exited: Promise<number> };

const bunOverrides = Bun as unknown as {
  spawn: SpawnImpl;
  which: (bin: string) => string | null;
  spawnSync: (cmd: string[]) => { exitCode: number };
};

function setSpawn(impl: SpawnImpl) {
  bunOverrides.spawn = impl;
  if (bunOverrides.spawn !== impl) {
    throw new Error("Failed to mock Bun.spawn — property may be non-writable");
  }
}
function restoreSpawn() {
  bunOverrides.spawn = origSpawn as unknown as SpawnImpl;
}

function mockWhich(present: ReadonlySet<string>) {
  const impl = (bin: string) => (present.has(bin) ? `/usr/local/bin/${bin}` : null);
  bunOverrides.which = impl;
  if (bunOverrides.which !== impl) {
    throw new Error("Failed to mock Bun.which — property may be non-writable");
  }
}
function restoreWhich() {
  bunOverrides.which = origWhich;
}

function mockSpawnSync(yarnDlxExitCode: number) {
  const impl = (cmd: string[]) => {
    if (cmd[0] === "yarn" && cmd[1] === "dlx") return { exitCode: yarnDlxExitCode };
    return { exitCode: 0 };
  };
  bunOverrides.spawnSync = impl;
  if (bunOverrides.spawnSync !== impl) {
    throw new Error("Failed to mock Bun.spawnSync — property may be non-writable");
  }
}
function restoreSpawnSync() {
  bunOverrides.spawnSync = origSpawnSync as unknown as (cmd: string[]) => { exitCode: number };
}

/** Minimal ProjectContext suitable for driving runFormatters. */
function makeCtx(overrides: Partial<ProjectContext> & { cwd: string }): ProjectContext {
  return {
    framework: {
      name: "next",
      sdk: "@clerk/nextjs",
      dep: "next",
      envFile: ".env.local",
    } as ProjectContext["framework"],
    typescript: true,
    srcDir: false,
    packageManager: "bun",
    existingClerk: false,
    deps: {},
    envFile: ".env.local",
    ...overrides,
  };
}

describe("runFormatters", () => {
  let tempDir: string;
  let spawnCalls: SpawnArgs[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-format-"));
    spawnCalls = [];
    setSpawn((cmd) => {
      spawnCalls.push(cmd);
      return { exited: Promise.resolve(0) };
    });
    mockWhich(new Set(["bunx", "npx", "pnpm", "yarn"]));
    mockSpawnSync(0);
  });

  afterEach(async () => {
    restoreSpawn();
    restoreWhich();
    restoreSpawnSync();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("no-op when files is empty", async () => {
    const ctx = makeCtx({ cwd: tempDir, deps: { prettier: "3.0.0" } });
    await runFormatters(ctx, []);
    expect(spawnCalls).toHaveLength(0);
  });

  test("no-op when no supported formatter is in deps", async () => {
    const ctx = makeCtx({ cwd: tempDir, deps: { next: "15.0.0" } });
    await runFormatters(ctx, ["a.ts"]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("runs prettier via the package-manager's preferred runner (bun → bunx)", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: { prettier: "3.0.0" },
    });
    await runFormatters(ctx, ["src/a.ts", "src/b.ts"]);
    expect(spawnCalls).toEqual([
      [
        "bunx",
        "--package",
        "prettier@latest",
        "--",
        "prettier",
        "--ignore-unknown",
        "--write",
        "src/a.ts",
        "src/b.ts",
      ],
    ]);
  });

  test("runs biome via pnpm dlx when packageManager is pnpm", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "pnpm",
      deps: { "@biomejs/biome": "1.9.0" },
    });
    await runFormatters(ctx, ["src/a.ts"]);
    // pnpm dlx fetches the package into an isolated store (no pin needed) and
    // runs its `biome` bin.
    expect(spawnCalls).toEqual([
      ["pnpm", "dlx", "@biomejs/biome@latest", "format", "--write", "src/a.ts"],
    ]);
  });

  test("runs both prettier and biome when both are in deps, in FORMATTERS order", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "npm",
      deps: { prettier: "3.0.0", "@biomejs/biome": "1.9.0" },
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toEqual([
      [
        "npx",
        "--package",
        "prettier@latest",
        "--",
        "prettier",
        "--ignore-unknown",
        "--write",
        "x.ts",
      ],
      ["npx", "--package", "@biomejs/biome@latest", "--", "biome", "format", "--write", "x.ts"],
    ]);
  });

  test("falls back to the first available runner when the pm's runner is missing", async () => {
    // Project says bun, but only npx/pnpm are on PATH.
    mockWhich(new Set(["npx", "pnpm"]));
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: { prettier: "3.0.0" },
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toEqual([
      [
        "npx",
        "--package",
        "prettier@latest",
        "--",
        "prettier",
        "--ignore-unknown",
        "--write",
        "x.ts",
      ],
    ]);
  });

  test("skips silently when no runners are on PATH", async () => {
    mockWhich(new Set());
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: { prettier: "3.0.0" },
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("excludes yarn when yarn dlx probe fails (Yarn Classic)", async () => {
    mockWhich(new Set(["yarn"]));
    mockSpawnSync(1); // yarn dlx --help exits non-zero
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "yarn",
      deps: { prettier: "3.0.0" },
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("swallows spawn errors (best-effort) and continues to later formatters", async () => {
    const attempted: SpawnArgs[] = [];
    setSpawn((cmd) => {
      attempted.push(cmd);
      if (cmd.includes("prettier")) {
        throw new Error("spawn failed");
      }
      return { exited: Promise.resolve(0) };
    });
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "npm",
      deps: { prettier: "3.0.0", "@biomejs/biome": "1.9.0" },
    });
    // Should not throw even though prettier spawn blows up.
    await runFormatters(ctx, ["x.ts"]);
    expect(attempted).toEqual([
      [
        "npx",
        "--package",
        "prettier@latest",
        "--",
        "prettier",
        "--ignore-unknown",
        "--write",
        "x.ts",
      ],
      ["npx", "--package", "@biomejs/biome@latest", "--", "biome", "format", "--write", "x.ts"],
    ]);
  });

  test("ignores non-zero exit code from formatter (best-effort)", async () => {
    setSpawn((cmd) => {
      spawnCalls.push(cmd);
      return { exited: Promise.resolve(1) };
    });
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "npm",
      deps: { prettier: "3.0.0", "@biomejs/biome": "1.9.0" },
    });
    await runFormatters(ctx, ["x.ts"]);
    // Both formatters attempted despite prettier exiting non-zero.
    expect(spawnCalls).toEqual([
      [
        "npx",
        "--package",
        "prettier@latest",
        "--",
        "prettier",
        "--ignore-unknown",
        "--write",
        "x.ts",
      ],
      ["npx", "--package", "@biomejs/biome@latest", "--", "biome", "format", "--write", "x.ts"],
    ]);
  });

  test("no-op when ctx.deps is empty", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: {},
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("pins the package so the runner can't resolve a project-local bin", async () => {
    let seenCwd: string | undefined;
    setSpawn((cmd, opts?: { cwd?: string }) => {
      seenCwd = opts?.cwd;
      spawnCalls.push(cmd);
      return { exited: Promise.resolve(0) };
    });
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: { prettier: "3.0.0" },
    });
    await runFormatters(ctx, ["x.ts"]);

    const cmd = spawnCalls[0]!;
    // The bin only appears after the `--`, never as a bare argv the runner
    // could resolve from node_modules/.bin.
    expect(cmd.slice(0, 4)).toEqual(["bunx", "--package", "prettier@latest", "--"]);
    expect(seenCwd).toBe(tempDir);
  });
});
