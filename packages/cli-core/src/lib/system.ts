/**
 * System collaborator.
 *
 * Canonical wrapper for process-I/O: binary lookup and subprocess spawning.
 * Every call site that would otherwise use `Bun.which`, `Bun.spawn`, or
 * `Bun.spawnSync` routes through `deps.system` instead. The real impl is
 * a thin adapter over Bun globals; tests use `createFakeSystem()` from
 * `./system.fake.ts`.
 *
 * Two convenience helpers cover the repeating patterns in our call sites:
 *   runInherit — spawn with stdout/stderr inherited, await exit code
 *   runCapture — spawn with piped stdout/stderr, await completion and text
 *
 * The low-level `spawn`/`spawnSync` escape hatches are retained for the
 * yarn-dlx probe (sync) and the skills-installer flow (async with stdin).
 */

export interface System {
  which(bin: string): string | null;
  spawn(cmd: string[], opts?: SpawnOptions): Bun.Subprocess;
  spawnSync(cmd: string[], opts?: SpawnOptions): Bun.SyncSubprocess;
  runInherit(cmd: string[], opts?: RunOptions): Promise<number>;
  runCapture(cmd: string[], opts?: RunOptions): Promise<RunCaptureResult>;
}

export type SpawnOptions = {
  cwd?: string;
  stdin?: "inherit" | "ignore" | "pipe";
  stdout?: "inherit" | "ignore" | "pipe";
  stderr?: "inherit" | "ignore" | "pipe";
};

export type RunOptions = {
  cwd?: string;
};

export type RunCaptureResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const realSystem: System = {
  which(bin) {
    return Bun.which(bin);
  },
  spawn(cmd, opts) {
    return Bun.spawn(cmd, opts as Parameters<typeof Bun.spawn>[1]);
  },
  spawnSync(cmd, opts) {
    return Bun.spawnSync(cmd, opts as Parameters<typeof Bun.spawnSync>[1]);
  },
  async runInherit(cmd, opts) {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  },
  async runCapture(cmd, opts) {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

export function createSystem(): System {
  return realSystem;
}
