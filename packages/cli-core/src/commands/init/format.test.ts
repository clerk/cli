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

function setSpawn(impl: SpawnImpl) {
  try {
    (Bun as unknown as { spawn: SpawnImpl }).spawn = impl;
  } catch {
    // Bun.spawn may not be writable on some runtimes
  }
}
function restoreSpawn() {
  try {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
  } catch {
    // ignore
  }
}

function mockWhich(present: ReadonlySet<string>) {
  try {
    (Bun as unknown as { which: (bin: string) => string | null }).which = (bin) =>
      present.has(bin) ? `/usr/local/bin/${bin}` : null;
  } catch {
    // ignore
  }
}
function restoreWhich() {
  try {
    (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
  } catch {
    // ignore
  }
}

function mockSpawnSync(yarnDlxExitCode: number) {
  try {
    (Bun as unknown as { spawnSync: (cmd: string[]) => { exitCode: number } }).spawnSync = (
      cmd,
    ) => {
      if (cmd[0] === "yarn" && cmd[1] === "dlx") return { exitCode: yarnDlxExitCode };
      return { exitCode: 0 };
    };
  } catch {
    // ignore
  }
}
function restoreSpawnSync() {
  try {
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
  } catch {
    // ignore
  }
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
      ["bunx", "prettier", "--ignore-unknown", "--write", "src/a.ts", "src/b.ts"],
    ]);
  });

  test("runs biome via pnpm dlx when packageManager is pnpm", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "pnpm",
      deps: { "@biomejs/biome": "1.9.0" },
    });
    await runFormatters(ctx, ["src/a.ts"]);
    expect(spawnCalls).toEqual([
      ["pnpm", "dlx", "@biomejs/biome", "format", "--write", "src/a.ts"],
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
      ["npx", "prettier", "--ignore-unknown", "--write", "x.ts"],
      ["npx", "@biomejs/biome", "format", "--write", "x.ts"],
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
    expect(spawnCalls).toEqual([["npx", "prettier", "--ignore-unknown", "--write", "x.ts"]]);
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
      if (cmd[1] === "prettier") {
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
      ["npx", "prettier", "--ignore-unknown", "--write", "x.ts"],
      ["npx", "@biomejs/biome", "format", "--write", "x.ts"],
    ]);
  });

  test("reads deps from disk when ctx.deps is empty", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { prettier: "3.0.0" } }),
    );
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: {}, // empty → triggers disk fallback
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toEqual([["bunx", "prettier", "--ignore-unknown", "--write", "x.ts"]]);
  });

  test("no-op when ctx.deps is empty and package.json is missing", async () => {
    const ctx = makeCtx({
      cwd: tempDir,
      packageManager: "bun",
      deps: {},
    });
    await runFormatters(ctx, ["x.ts"]);
    expect(spawnCalls).toHaveLength(0);
  });

  test("spawns in the project cwd", async () => {
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
    expect(seenCwd).toBe(tempDir);
  });
});
