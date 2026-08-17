import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EXIT_CODE } from "./errors.ts";
import {
  _resetInterruptState,
  beginInterrupt,
  exitInterrupted,
  interruptedExitCode,
  whileWaiting,
} from "./signals.ts";

/**
 * `exitInterrupted` never returns, so every call site here throws out of the
 * stubbed `process.exit` instead. Assertions read the recorded code.
 */
function stubExit() {
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
}

let exitSpy: ReturnType<typeof stubExit>;

beforeEach(() => {
  _resetInterruptState();
  exitSpy = stubExit();
});

afterEach(() => {
  exitSpy.mockRestore();
  _resetInterruptState();
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
    const outer = whileWaiting(
      (async () => {
        await whileWaiting(Promise.resolve());
        expect(beginInterrupt()).toBe(EXIT_CODE.SUCCESS);
      })(),
    );
    await outer;
  });

  test("passes the wrapped value through", async () => {
    expect(await whileWaiting(Promise.resolve(42))).toBe(42);
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

  test("plain-exits when no interrupt was ever recorded", () => {
    // Guards the re-raise: claiming to die from a signal we never received
    // would misreport the run, and `process.kill` is not stubbable.
    expect(interruptedExitCode()).toBeNull();
    expect(exitCodeFrom(() => exitInterrupted(EXIT_CODE.SIGINT))).toBe(EXIT_CODE.SIGINT);
  });

  test("never re-raises when process.exit is stubbed to return", () => {
    // Regression: the guard used to rely on `process.exit` not returning. A
    // no-op stub — which `listen.test.ts` installs — fell straight through to
    // `process.kill`, killing the test runner instead of failing an assertion.
    exitSpy.mockRestore();
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
    const killSpy = spyOn(process, "kill").mockImplementation((() => true) as never);
    try {
      beginInterrupt();
      exitInterrupted(EXIT_CODE.SIGINT);
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CODE.SIGINT);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
