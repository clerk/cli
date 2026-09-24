import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { UserAbortError } from "../../../lib/errors.ts";
import { getLogLevel, setLogLevel } from "../../../lib/log.ts";
import * as spinner from "../../../lib/spinner.ts";
import { getMode, setMode } from "../../../mode.ts";
import {
  setNativeProgressPhase,
  stopNativeProgress,
  withNativeProgress,
  withNativeSpinner,
} from "./presentation.ts";

const originalMode = getMode();
const originalLevel = getLogLevel();
let indicators: Array<{
  message: string;
  update: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  fail: ReturnType<typeof mock>;
}>;
let create: ReturnType<typeof spyOn<typeof spinner, "createSpinner">>;

beforeEach(() => {
  setMode("human");
  setLogLevel("info");
  indicators = [];
  create = spyOn(spinner, "createSpinner").mockImplementation((message) => {
    const indicator = { message, update: mock(), stop: mock(), fail: mock() };
    indicators.push(indicator);
    return indicator;
  });
});

afterEach(() => {
  create.mockRestore();
  setMode(originalMode);
  setLogLevel(originalLevel);
});

test("sequential checks and nested updates keep one spinner with one phase label", async () => {
  const result = await withNativeProgress(async () => {
    await withNativeSpinner("Detecting framework...", async () => {});
    await withNativeSpinner("Finding targets...", async ({ update }) => {
      update("Inspecting another target...");
      await withNativeSpinner("Reading build settings...", async () => {});
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(indicators[0]!.stop).not.toHaveBeenCalled();
    return 42;
  });
  expect(result).toBe(42);
  expect(indicators[0]!.message).toBe("Inspecting your project...");
  expect(indicators[0]!.update).not.toHaveBeenCalled();
  expect(indicators[0]!.stop).toHaveBeenCalledTimes(1);
});

test("a prompt boundary stops progress until work resumes, and a new phase gets a new label", async () => {
  await withNativeProgress(async () => {
    await withNativeSpinner("Finding targets...", async () => {});
    stopNativeProgress();
    expect(indicators[0]!.stop).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // The user may spend any amount of time at the prompt.
    expect(create).toHaveBeenCalledTimes(1);
    await withNativeSpinner("Inspecting chosen target...", async () => {});
    expect(indicators[1]!.message).toBe("Inspecting your project...");
    setNativeProgressPhase("Checking Clerk settings...");
    expect(indicators[1]!.stop).toHaveBeenCalledTimes(1);
    await withNativeSpinner("Fetching key...", async () => {});
    await withNativeSpinner("Checking registration...", async () => {});
  });
  expect(indicators.map(({ message }) => message)).toEqual([
    "Inspecting your project...",
    "Inspecting your project...",
    "Checking Clerk settings...",
  ]);
  expect(indicators[2]!.stop).toHaveBeenCalledTimes(1);
});

test.each([
  { outcome: "failure", error: new Error("Failed check") },
  { outcome: "cancellation", error: new UserAbortError() },
])(
  "$outcome cleans up and cannot leave a spinner attached to the next command",
  async ({ error }) => {
    await expect(
      withNativeProgress(async () => {
        await withNativeSpinner("Checking...", async () => {
          throw error;
        });
      }),
    ).rejects.toBe(error);
    expect(indicators[0]!.fail).toHaveBeenCalledWith(error);
    expect(indicators[0]!.stop).toHaveBeenCalled();
    await withNativeProgress(async () => {
      await withNativeSpinner("Checking again...", async () => {});
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(indicators[1]!.fail).not.toHaveBeenCalled();
    expect(indicators[1]!.stop).toHaveBeenCalledTimes(1);
  },
);

test.each(["verbose", "agent"] as const)(
  "%s mode retains individual check handling",
  async (mode) => {
    if (mode === "agent") setMode("agent");
    else setLogLevel("debug");
    const individual = spyOn(spinner, "withSpinner").mockImplementation(async (_message, fn) =>
      fn({ update: () => {} }),
    );
    try {
      await withNativeProgress(async () => {
        await withNativeSpinner("Detecting framework...", async () => {});
        await withNativeSpinner("Finding targets...", async () => {});
      });
      expect(create).not.toHaveBeenCalled();
      expect(individual.mock.calls.map(([message]) => message)).toEqual([
        "Detecting framework...",
        "Finding targets...",
      ]);
    } finally {
      individual.mockRestore();
    }
  },
);
