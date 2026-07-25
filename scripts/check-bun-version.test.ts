import { test, expect, describe } from "bun:test";
import { checkBunVersion } from "./check-bun-version.ts";

describe("checkBunVersion", () => {
  test.each([
    ["1.3.13", ">=1.3.13", true],
    ["1.4.0", ">=1.3.13", true],
    ["2.0.0", ">=1.3.13", true],
    ["1.4.0-canary.20260101", ">=1.3.13", true],
    ["1.3.12", ">=1.3.13", false],
    ["1.3.11", ">=1.3.13", false],
    ["1.2.0", ">=1.3.13", false],
  ])("version %s against %s -> ok=%p", (current, range, ok) => {
    expect(checkBunVersion(current, range).ok).toBe(ok);
  });

  test("failure message names the required range and the found version", () => {
    const result = checkBunVersion("1.3.11", ">=1.3.13");
    expect(result.ok).toBe(false);
    expect(result.message).toContain(">=1.3.13");
    expect(result.message).toContain("1.3.11");
    expect(result.message).toContain("bun upgrade");
  });

  test("success carries no message", () => {
    expect(checkBunVersion("1.3.13", ">=1.3.13").message).toBeUndefined();
  });
});
