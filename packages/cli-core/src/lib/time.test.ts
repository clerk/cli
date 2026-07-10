import { test, expect, describe } from "bun:test";
import { formatRelativeTime } from "./time.ts";

const NOW = 1_000_000_000_000;
const sec = 1000;
const min = 60 * sec;
const hr = 60 * min;
const day = 24 * hr;

describe("formatRelativeTime", () => {
  test("under a minute reads 'just now'", () => {
    expect(formatRelativeTime(NOW - 30 * sec, NOW)).toBe("just now");
  });
  test("minutes, hours, days", () => {
    expect(formatRelativeTime(NOW - 5 * min, NOW)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 3 * hr, NOW)).toBe("3h ago");
    expect(formatRelativeTime(NOW - 8 * day, NOW)).toBe("8d ago");
  });
  test("months and years", () => {
    expect(formatRelativeTime(NOW - 45 * day, NOW)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 400 * day, NOW)).toBe("1y ago");
  });
  test("future or equal clamps to 'just now'", () => {
    expect(formatRelativeTime(NOW + 5 * min, NOW)).toBe("just now");
  });
});
