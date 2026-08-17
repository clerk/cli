/**
 * The shell-visible half of the Ctrl-C contract.
 *
 * `process.exit(130)` and dying from SIGINT both make the shell print 130, but
 * only the latter sets `WIFSIGNALED`, which is what a wrapping script inspects
 * to decide whether to stop. A spy on `process.exit` cannot tell the two apart,
 * so this has to run in a real child process, with the test-only escape hatch
 * that suppresses re-raising explicitly cleared from the child's environment.
 */

import { describe, expect, test } from "bun:test";

const SIGNALS_MODULE = `${import.meta.dir}/signals.ts`;

type Outcome = { exitCode: number | null; signalCode: string | null };

async function runInterrupted(mode: "work" | "wait"): Promise<Outcome> {
  const source = `
    const { CLI_SIGINT_HANDLER, whileAwaitingUser } = await import(${JSON.stringify(SIGNALS_MODULE)});
    process.on("SIGINT", CLI_SIGINT_HANDLER);
    if (${JSON.stringify(mode)} === "wait") {
      // Deliberately not awaited: opening the wait is what the handler reads.
      whileAwaitingUser(new Promise((resolve) => setTimeout(resolve, 30_000)));
    }
    setTimeout(() => process.kill(process.pid, "SIGINT"), 50);
    setTimeout(() => process.exit(99), 10_000); // guard against a hang
  `;

  const { CLERK_CLI_NO_SIGNAL_RERAISE: _suppressed, ...cleanEnv } = process.env;
  const proc = Bun.spawn(["bun", "-e", source], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...cleanEnv,
      // Never emit a real event from a test run.
      CLERK_TELEMETRY_DISABLED: "1",
    },
  });

  const exitCode = await proc.exited;
  return { exitCode, signalCode: proc.signalCode };
}

describe("Ctrl-C as the shell sees it", () => {
  test("an interrupted operation dies from SIGINT rather than exiting 130", async () => {
    const { signalCode } = await runInterrupted("work");
    // WIFSIGNALED with WTERMSIG=SIGINT. Bun reports exitCode as null here.
    expect(signalCode).toBe("SIGINT");
  }, 15_000);

  test("an interrupted wait exits 0 cleanly, with no signal death", async () => {
    const { exitCode, signalCode } = await runInterrupted("wait");
    expect(signalCode).toBeNull();
    expect(exitCode).toBe(0);
  }, 15_000);
});
