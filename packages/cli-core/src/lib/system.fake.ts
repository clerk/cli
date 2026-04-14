/**
 * In-memory System for tests. Binary lookups consult a map; spawn-family
 * methods return FIFO-queued results. Every call is recorded on `calls`
 * so tests can assert the command/opts the production code attempted.
 */

import type { RunCaptureResult, RunOptions, SpawnOptions, System } from "./system.ts";

export type FakeSpawnResult = { exitCode: number } | { throw: Error };

export interface FakeSystem extends System {
  setBinary(bin: string, path: string | null): void;
  queueSpawn(result: FakeSpawnResult): void;
  queueSpawnSync(
    result: Bun.SyncSubprocess | { exitCode: number; stdout: string; stderr: string },
  ): void;
  queueRunInherit(result: number | Error): void;
  queueRunCapture(result: RunCaptureResult | Error): void;
  readonly calls: {
    which: string[];
    spawn: Array<{ cmd: string[]; opts?: SpawnOptions }>;
    spawnSync: Array<{ cmd: string[]; opts?: SpawnOptions }>;
    runInherit: Array<{ cmd: string[]; opts?: RunOptions }>;
    runCapture: Array<{ cmd: string[]; opts?: RunOptions }>;
  };
}

export function createFakeSystem(init?: { binaries?: Record<string, string | null> }): FakeSystem {
  const binaries = new Map<string, string | null>(Object.entries(init?.binaries ?? {}));
  const spawnQueue: FakeSpawnResult[] = [];
  const spawnSyncQueue: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  const runInheritQueue: Array<number | Error> = [];
  const runCaptureQueue: Array<RunCaptureResult | Error> = [];

  const calls: FakeSystem["calls"] = {
    which: [],
    spawn: [],
    spawnSync: [],
    runInherit: [],
    runCapture: [],
  };

  return {
    calls,
    setBinary(bin, path) {
      binaries.set(bin, path);
    },
    queueSpawn(result) {
      spawnQueue.push(result);
    },
    queueSpawnSync(result) {
      spawnSyncQueue.push({
        exitCode: result.exitCode,
        stdout: "stdout" in result ? String(result.stdout ?? "") : "",
        stderr: "stderr" in result ? String(result.stderr ?? "") : "",
      });
    },
    queueRunInherit(result) {
      runInheritQueue.push(result);
    },
    queueRunCapture(result) {
      runCaptureQueue.push(result);
    },
    which(bin) {
      calls.which.push(bin);
      return binaries.get(bin) ?? null;
    },
    spawn(cmd, opts) {
      calls.spawn.push({ cmd, opts });
      const next = spawnQueue.shift();
      if (!next) throw new Error(`FakeSystem.spawn: no queued spawn for ${cmd.join(" ")}`);
      if ("throw" in next) throw next.throw;
      // Mimic Bun.Subprocess: only `.exited` is read by our production code.
      return { exited: Promise.resolve(next.exitCode) } as unknown as Bun.Subprocess;
    },
    spawnSync(cmd, opts) {
      calls.spawnSync.push({ cmd, opts });
      const next = spawnSyncQueue.shift();
      if (!next) throw new Error(`FakeSystem.spawnSync: no queued spawnSync for ${cmd.join(" ")}`);
      return next as unknown as Bun.SyncSubprocess;
    },
    async runInherit(cmd, opts) {
      calls.runInherit.push({ cmd, opts });
      const next = runInheritQueue.shift();
      if (next === undefined) {
        throw new Error(`FakeSystem.runInherit: no queued runInherit for ${cmd.join(" ")}`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
    async runCapture(cmd, opts) {
      calls.runCapture.push({ cmd, opts });
      const next = runCaptureQueue.shift();
      if (next === undefined) {
        throw new Error(`FakeSystem.runCapture: no queued runCapture for ${cmd.join(" ")}`);
      }
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
