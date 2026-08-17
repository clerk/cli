import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EXIT_CODE } from "./errors.ts";
import {
  _resetInterruptState,
  beginInterrupt,
  CLI_SIGINT_HANDLER,
  exitInterrupted,
  interruptedExitCode,
  interruptSignal,
  markCommandComplete,
  whileWaiting,
} from "./signals.ts";

/**
 * Re-raising is a real `process.kill`, which a stubbed `process.exit` cannot
 * intercept — reaching it here would kill the test runner. The CLI reads this
 * var to plain-exit instead; the subprocess test covers the real signal death.
 */
const NO_RERAISE = "CLERK_CLI_NO_SIGNAL_RERAISE";

function stubExit() {
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
}

let exitSpy: ReturnType<typeof stubExit>;

beforeEach(() => {
  process.env[NO_RERAISE] = "1";
  _resetInterruptState();
  exitSpy = stubExit();
});

afterEach(() => {
  exitSpy.mockRestore();
  _resetInterruptState();
  delete process.env[NO_RERAISE];
});

function exitCodeFrom(fn: () => never): number {
  expect(fn).toThrow("process.exit");
  const calls = exitSpy.mock.calls;
  return calls[calls.length - 1]![0] as number;
}

describe("whileWaiting", () => {
  test("classifies an interrupt during a wait as a clean exit", async () => {
    const pending = whileWaiting(new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(beginInterrupt()).toBe(EXIT_CODE.SUCCESS);
    await pending;
  });

  test("classifies an interrupt outside a wait as SIGINT", () => {
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
  });

  test("stops counting once the wait resolves", async () => {
    await whileWaiting(Promise.resolve("done"));
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
  });

  test("stops counting when the wait rejects", async () => {
    await expect(whileWaiting(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
  });

  test("nests, so an inner wait finishing does not unmark the outer one", async () => {
    await whileWaiting(
      (async () => {
        await whileWaiting(Promise.resolve());
        expect(beginInterrupt()).toBe(EXIT_CODE.SUCCESS);
      })(),
    );
  });

  test("passes the wrapped value through", async () => {
    expect(await whileWaiting(Promise.resolve(42))).toBe(42);
  });
});

describe("markCommandComplete", () => {
  test("makes the bookkeeping tail a clean exit", () => {
    // The update check and telemetry flush run after the command has printed
    // its output. Interrupting them must not kill a successful run with a
    // signal, which would halt any script wrapping the CLI.
    expect(interruptedExitCode()).toBeNull();
    markCommandComplete();
    expect(beginInterrupt()).toBe(EXIT_CODE.SUCCESS);
  });

  test("does not affect an interrupt that lands before the command finishes", () => {
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
  });
});

describe("beginInterrupt", () => {
  test("latches the first verdict so a later wait cannot change it", async () => {
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
    const pending = whileWaiting(new Promise<void>((resolve) => setTimeout(resolve, 10)));
    expect(beginInterrupt()).toBe(EXIT_CODE.SIGINT);
    await pending;
  });

  test("is what interruptedExitCode reports", () => {
    expect(interruptedExitCode()).toBeNull();
    beginInterrupt();
    expect(interruptedExitCode()).toBe(EXIT_CODE.SIGINT);
  });
});

describe("exitInterrupted", () => {
  test("exits with a clean code when the interrupt landed during a wait", async () => {
    const pending = whileWaiting(new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const code = beginInterrupt();
    expect(exitCodeFrom(() => exitInterrupted(code))).toBe(EXIT_CODE.SUCCESS);
    await pending;
  });

  test("exits 130 for an interrupted operation", () => {
    beginInterrupt();
    expect(exitCodeFrom(() => exitInterrupted(EXIT_CODE.SIGINT))).toBe(EXIT_CODE.SIGINT);
  });

  test("plain-exits, without killing, when no interrupt was recorded", () => {
    // Guards the re-raise: claiming to die from a signal we never received
    // would misreport the run. Asserted against `process.kill` directly so the
    // env escape hatch cannot make this pass for the wrong reason.
    const killSpy = spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      delete process.env[NO_RERAISE];
      expect(interruptedExitCode()).toBeNull();
      expect(exitCodeFrom(() => exitInterrupted(EXIT_CODE.SIGINT))).toBe(EXIT_CODE.SIGINT);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      process.env[NO_RERAISE] = "1";
      killSpy.mockRestore();
    }
  });

  test("a guarded branch does not fall through when process.exit returns", () => {
    // Regression: the guard used to rely on `process.exit` not returning. A
    // no-op stub — which `listen.test.ts` installs — fell straight through to
    // `process.kill`, killing the test runner instead of failing an assertion.
    // Exercised with a clean exit, which the guard must short-circuit even
    // though an interrupt was recorded and the escape hatch is off.
    exitSpy.mockRestore();
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
    const killSpy = spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      delete process.env[NO_RERAISE];
      beginInterrupt();
      exitInterrupted(EXIT_CODE.SUCCESS);
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE.SUCCESS);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      process.env[NO_RERAISE] = "1";
      killSpy.mockRestore();
    }
  });
});

describe("CLI_SIGINT_HANDLER", () => {
  /** `finalizeAndSendTelemetry`'s shape, so `.mock.calls` stays typed. */
  const flushSpy = () => mock(async (_result: { outcome: string; exitCode: number }) => {});

  function fakeTty(): () => void {
    const original = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    return () => {
      if (original) Object.defineProperty(process.stderr, "isTTY", original);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    };
  }

  test("aborts in-flight work, restores the cursor, and flushes telemetry", async () => {
    const flush = flushSpy();
    mock.module("./telemetry.ts", () => ({ finalizeAndSendTelemetry: flush }));
    const restoreTty = fakeTty();
    const writes: string[] = [];
    const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    try {
      expect(interruptSignal().aborted).toBe(false);
      await expect(CLI_SIGINT_HANDLER()).rejects.toThrow("process.exit");

      expect(interruptSignal().aborted).toBe(true); // in-flight requests cancelled
      expect(writes.join("")).toContain("\x1b[?25h"); // cursor restored
      expect(flush).toHaveBeenCalled(); // interrupted run reported
      expect(flush.mock.calls[0]?.[0]).toMatchObject({
        outcome: "abort",
        exitCode: EXIT_CODE.SIGINT,
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE.SIGINT);
    } finally {
      errSpy.mockRestore();
      restoreTty();
    }
  });

  test("a second Ctrl-C exits immediately without re-flushing", async () => {
    const flush = flushSpy();
    mock.module("./telemetry.ts", () => ({ finalizeAndSendTelemetry: flush }));

    beginInterrupt(); // stand in for the first press having already landed
    await expect(CLI_SIGINT_HANDLER()).rejects.toThrow("process.exit");

    expect(flush).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE.SIGINT);
  });
});
