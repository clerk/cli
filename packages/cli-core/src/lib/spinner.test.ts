import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { useCaptureLog } from "../test/lib/stubs.ts";

mock.module("../mode.ts", () => ({
  getMode: () => "human",
  isAgent: () => false,
  isHuman: () => true,
  setMode: () => {},
}));

const { withSpinner } = await import("./spinner.ts");

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

describe("withSpinner", () => {
  const captured = useCaptureLog();
  const originalCI = process.env.CI;
  const originalIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    delete process.env.CI;
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    process.env.CI = originalCI;
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
  });

  test("lets callbacks update the active spinner message", async () => {
    await withSpinner("Checking status...", async ({ update }) => {
      update("Checking status... Retrying in 5");
    });

    expect(stripAnsi(captured.err)).toContain("Checking status... Retrying in 5");
  });
});
