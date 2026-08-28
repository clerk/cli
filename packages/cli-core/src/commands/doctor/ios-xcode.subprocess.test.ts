import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IOS_XCODE_MODULE = `${import.meta.dir}/ios-xcode.ts`;
const SIGNALS_MODULE = `${import.meta.dir}/../../lib/signals.ts`;

type ParentShutdown = "direct-exit" | "sigint";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ProcessTreePIDs = {
  leader: number;
  descendant: number;
};

async function readProcessTreePIDs(path: string): Promise<ProcessTreePIDs | undefined> {
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as {
      leader?: unknown;
      descendant?: unknown;
    };
    if (
      Number.isSafeInteger(parsed.leader) &&
      Number(parsed.leader) > 0 &&
      Number.isSafeInteger(parsed.descendant) &&
      Number(parsed.descendant) > 0
    ) {
      return { leader: Number(parsed.leader), descendant: Number(parsed.descendant) };
    }
  } catch {}
  return undefined;
}

async function waitForProcessTreePIDs(path: string): Promise<ProcessTreePIDs> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const pids = await readProcessTreePIDs(path);
    if (pids) return pids;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the Xcode fixture process tree");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (processIsAlive(pid) && performance.now() < deadline) {
    await Bun.sleep(10);
  }
}

async function runSuccessfulLeaderWithBackgroundDescendant(): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | undefined;
  descendantAlive: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "clerk-doctor-ios-xcode-success-test-"));
  const descendantScript = join(root, "descendant.ts");
  const parentScript = join(root, "xcode-parent.ts");
  const pidPath = join(root, "descendant.pid");
  await Bun.write(descendantScript, "setInterval(() => {}, 1_000);\n");
  await Bun.write(
    parentScript,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\nawait Bun.write(${JSON.stringify(pidPath)}, JSON.stringify({ leader: process.pid, descendant: child.pid }));\nprocess.exit(0);\n`,
  );

  const { createIOSXcodeChildEnvironment, runIOSXcodeCommand } = await import(IOS_XCODE_MODULE);
  let processTreePIDs: ProcessTreePIDs | undefined;
  try {
    const result = await runIOSXcodeCommand([process.execPath, parentScript], {
      cwd: root,
      env: createIOSXcodeChildEnvironment(process.env),
      timeoutMs: 30_000,
      maxOutputBytes: 128,
    });
    processTreePIDs = await waitForProcessTreePIDs(pidPath);
    await waitForProcessExit(processTreePIDs.descendant);
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      descendantAlive: processIsAlive(processTreePIDs.descendant),
    };
  } finally {
    if (!processTreePIDs) {
      const cleanupDeadline = performance.now() + 500;
      while (!processTreePIDs && performance.now() < cleanupDeadline) {
        processTreePIDs = await readProcessTreePIDs(pidPath);
        if (!processTreePIDs) await Bun.sleep(10);
      }
    }
    if (processTreePIDs) {
      try {
        process.kill(-processTreePIDs.leader, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function runParentShutdown(mode: ParentShutdown): Promise<{
  exitCode: number | null;
  signalCode: string | null;
  leaderAlive: boolean;
  descendantAlive: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "clerk-doctor-ios-xcode-signal-test-"));
  const descendantScript = join(root, "descendant.ts");
  const parentScript = join(root, "xcode-parent.ts");
  const pidPath = join(root, "descendant.pid");
  await Bun.write(
    descendantScript,
    'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1_000);\n',
  );
  await Bun.write(
    parentScript,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\nawait Bun.write(${JSON.stringify(pidPath)}, JSON.stringify({ leader: process.pid, descendant: child.pid }));\nsetInterval(() => {}, 1_000);\n`,
  );

  const signalSetup =
    mode === "sigint"
      ? `const { CLI_SIGINT_HANDLER } = await import(${JSON.stringify(SIGNALS_MODULE)});\nprocess.on("SIGINT", CLI_SIGINT_HANDLER);`
      : 'process.on("SIGUSR1", () => process.exit(0));';
  const harnessSource = `
    const { createIOSXcodeChildEnvironment, runIOSXcodeCommand } = await import(${JSON.stringify(IOS_XCODE_MODULE)});
    ${signalSetup}
    void runIOSXcodeCommand([process.execPath, ${JSON.stringify(parentScript)}], {
      cwd: ${JSON.stringify(root)},
      env: createIOSXcodeChildEnvironment(process.env),
      timeoutMs: 30_000,
      maxOutputBytes: 128,
    });
    setTimeout(() => process.exit(99), 10_000);
  `;
  const { CLERK_CLI_NO_SIGNAL_RERAISE: _suppressed, ...cleanEnv } = process.env;
  const harness = Bun.spawn([process.execPath, "-e", harnessSource], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...cleanEnv, CLERK_TELEMETRY_DISABLED: "1" },
  });

  let processTreePIDs: ProcessTreePIDs | undefined;
  try {
    processTreePIDs = await waitForProcessTreePIDs(pidPath);
    process.kill(harness.pid, mode === "sigint" ? "SIGINT" : "SIGUSR1");
    const exitCode = await harness.exited;
    await Promise.all([
      waitForProcessExit(processTreePIDs.leader),
      waitForProcessExit(processTreePIDs.descendant),
    ]);
    return {
      exitCode,
      signalCode: harness.signalCode,
      leaderAlive: processIsAlive(processTreePIDs.leader),
      descendantAlive: processIsAlive(processTreePIDs.descendant),
    };
  } finally {
    if (harness.exitCode === null) {
      try {
        harness.kill("SIGKILL");
      } catch {}
      await harness.exited;
    }
    if (!processTreePIDs) {
      const cleanupDeadline = performance.now() + 500;
      while (!processTreePIDs && performance.now() < cleanupDeadline) {
        processTreePIDs = await readProcessTreePIDs(pidPath);
        if (!processTreePIDs) await Bun.sleep(10);
      }
    }
    if (processTreePIDs) {
      try {
        process.kill(-processTreePIDs.leader, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}

describe("iOS Xcode command parent shutdown", () => {
  test.skipIf(process.platform === "win32")(
    "reaps a background descendant after a successful command",
    async () => {
      const outcome = await runSuccessfulLeaderWithBackgroundDescendant();

      expect(outcome.exitCode).toBe(0);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.spawnError).toBeUndefined();
      expect(outcome.descendantAlive).toBe(false);
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "terminates the detached process tree when the CLI receives SIGINT",
    async () => {
      const outcome = await runParentShutdown("sigint");

      expect(outcome.signalCode).toBe("SIGINT");
      expect(outcome.leaderAlive).toBe(false);
      expect(outcome.descendantAlive).toBe(false);
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "terminates the detached process tree when an interactive spinner exits directly",
    async () => {
      const outcome = await runParentShutdown("direct-exit");

      expect(outcome.exitCode).toBe(0);
      expect(outcome.signalCode).toBeNull();
      expect(outcome.leaderAlive).toBe(false);
      expect(outcome.descendantAlive).toBe(false);
    },
    15_000,
  );
});
