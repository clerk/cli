import { test, expect, mock, beforeEach } from "bun:test";
import { isInsideGutter } from "./log.ts";

// ── Mock state for @clack/prompts ────────────────────────────────────────────

let lastIntroTitle: string | undefined;
let introCalls = 0;
let lastOutroLabel: string | undefined;
let outroCalls = 0;

interface SpinnerCall {
  type: "start" | "stop" | "error" | "message";
  message?: string;
}
let spinnerCalls: SpinnerCall[] = [];

mock.module("@clack/prompts", () => ({
  intro: (title?: string) => {
    introCalls++;
    lastIntroTitle = title;
  },
  outro: (label?: string) => {
    outroCalls++;
    lastOutroLabel = label;
  },
  spinner: () => ({
    start: (message: string) => {
      spinnerCalls.push({ type: "start", message });
    },
    stop: (message?: string) => {
      spinnerCalls.push({ type: "stop", message });
    },
    message: (message?: string) => {
      spinnerCalls.push({ type: "message", message });
    },
    error: (message?: string) => {
      spinnerCalls.push({ type: "error", message });
    },
  }),
  // Stubs for sibling test-process exports
  cancel: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  confirm: async () => true,
  text: async () => "",
  password: async () => "",
}));

mock.module("../mode.ts", () => ({
  isHuman: () => true,
  isAgent: () => false,
  getMode: () => "human",
  setMode: () => {},
}));

// ── Stderr capture ───────────────────────────────────────────────────────────

let stderrChunks: string[] = [];
const originalWrite = process.stderr.write.bind(process.stderr);

function captureStderr<T>(fn: () => T): T {
  stderrChunks = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function captureStderrAsync<T>(fn: () => Promise<T>): Promise<T> {
  stderrChunks = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

const { intro, outro, pausedOutro, bar, withSpinner, withGutter } = await import("./spinner.ts");
const { UserAbortError } = await import("./errors.ts");

beforeEach(() => {
  introCalls = 0;
  outroCalls = 0;
  lastIntroTitle = undefined;
  lastOutroLabel = undefined;
  spinnerCalls = [];
  stderrChunks = [];
});

test("intro forwards the title to clack and pushes the gutter prefix", () => {
  expect(isInsideGutter()).toBe(false);
  intro("Welcome");
  expect(introCalls).toBe(1);
  expect(lastIntroTitle).toBe("Welcome");
  expect(isInsideGutter()).toBe(true);
  // Cleanup so other tests don't see prefix leak
  outro("Done");
  expect(isInsideGutter()).toBe(false);
});

test("outro forwards the label to clack and pops the gutter prefix", () => {
  intro("Hello");
  expect(isInsideGutter()).toBe(true);
  outro("All done");
  expect(outroCalls).toBe(1);
  expect(lastOutroLabel).toBe("All done");
  expect(isInsideGutter()).toBe(false);
});

test("outro with string[] renders custom Next steps block and does not call clack outro", async () => {
  intro("Hello");
  await captureStderrAsync(() => outro(["Run `clerk dev`", "Open the dashboard"]));

  // Custom block replaces clack's outro, so clack outro is not invoked.
  expect(outroCalls).toBe(0);
  expect(isInsideGutter()).toBe(false);

  const output = stderrChunks.join("");
  expect(output).toContain("Next steps");
  expect(output).toContain("Run `clerk dev`");
  expect(output).toContain("Open the dashboard");
});

test("pausedOutro renders Paused with resume instructions and pops the gutter prefix", () => {
  intro("Hello");
  captureStderr(() => {
    pausedOutro("Run this command again to continue.");
  });

  expect(isInsideGutter()).toBe(false);
  const output = stderrChunks.join("");
  expect(output).toContain("Paused");
  expect(output).toContain("Run this command again to continue.");
});

test("withGutter opens and closes the gutter on success", async () => {
  const result = await withGutter("Hello", async () => {
    expect(isInsideGutter()).toBe(true);
    return 42;
  });

  expect(result).toBe(42);
  expect(introCalls).toBe(1);
  expect(lastIntroTitle).toBe("Hello");
  expect(outroCalls).toBe(1);
  expect(lastOutroLabel).toBe("Done");
  expect(isInsideGutter()).toBe(false);
});

test("withGutter renders next steps on success", async () => {
  await captureStderrAsync(() =>
    withGutter("Hello", async ({ setNextSteps }) => {
      setNextSteps(["Run `clerk dev`"]);
    }),
  );

  expect(outroCalls).toBe(0);
  expect(isInsideGutter()).toBe(false);
  expect(stderrChunks.join("")).toContain("Run `clerk dev`");
});

test("withGutter closes as Failed and rethrows on errors", async () => {
  const boom = new Error("kaboom");
  await expect(
    withGutter("Hello", async () => {
      throw boom;
    }),
  ).rejects.toBe(boom);

  expect(outroCalls).toBe(1);
  expect(lastOutroLabel).toBe("Failed");
  expect(isInsideGutter()).toBe(false);
});

test("withGutter closes as Paused and rethrows on prompt aborts", async () => {
  await expect(
    captureStderrAsync(() =>
      withGutter("Hello", async () => {
        throw new UserAbortError();
      }),
    ),
  ).rejects.toBeInstanceOf(UserAbortError);

  expect(outroCalls).toBe(0);
  expect(isInsideGutter()).toBe(false);
  expect(stderrChunks.join("")).toContain("Paused");
});

test("withGutter skips wrapping when requested", async () => {
  const result = await withGutter(
    "Hello",
    async () => {
      expect(isInsideGutter()).toBe(false);
      return 42;
    },
    { skip: true },
  );

  expect(result).toBe(42);
  expect(introCalls).toBe(0);
  expect(outroCalls).toBe(0);
});

test("bar() writes a single │ line without throwing", () => {
  captureStderr(() => {
    bar();
  });
  const output = stderrChunks.join("");
  expect(output).toContain("│");
});

test("withSpinner starts, runs fn, and stops with success message", async () => {
  const result = await captureStderrAsync(() =>
    withSpinner("Loading...", async () => {
      return 42;
    }),
  );

  expect(result).toBe(42);
  const types = spinnerCalls.map((c) => c.type);
  expect(types).toEqual(["start", "stop"]);
  expect(spinnerCalls[0]?.message).toBe("Loading...");
  // Default doneMessage trims trailing "..."
  expect(spinnerCalls[1]?.message).toBe("Loading");
});

test("withSpinner uses an explicit doneMessage when provided", async () => {
  await captureStderrAsync(() => withSpinner("Fetching...", async () => undefined, "Fetched"));

  const stopCall = spinnerCalls.find((c) => c.type === "stop");
  expect(stopCall?.message).toBe("Fetched");
});

test("withSpinner lets callbacks update the active spinner message", async () => {
  await captureStderrAsync(() =>
    withSpinner("Checking status...", async ({ update }) => {
      update("Checking status... Retrying in 5");
    }),
  );

  const types = spinnerCalls.map((c) => c.type);
  expect(types).toEqual(["start", "message", "stop"]);
  expect(spinnerCalls[1]?.message).toBe("Checking status... Retrying in 5");
});

test("withSpinner calls error() on the spinner and rethrows when fn throws", async () => {
  const boom = new Error("kaboom");
  await expect(
    captureStderrAsync(() =>
      withSpinner("Working...", async () => {
        throw boom;
      }),
    ),
  ).rejects.toBe(boom);

  const types = spinnerCalls.map((c) => c.type);
  expect(types).toEqual(["start", "error"]);
  expect(spinnerCalls[1]?.message).toBe("Failed");
});
