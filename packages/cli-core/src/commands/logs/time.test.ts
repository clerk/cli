import { test, expect, describe } from "bun:test";
import { parseDuration, parseTimestamp, resolveTimeRange } from "./time.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseDuration", () => {
  test.each([
    ["30s", 30_000],
    ["15m", 15 * MINUTE],
    ["2h", 2 * HOUR],
    ["7d", 7 * DAY],
    ["1w", 7 * DAY],
    ["1h30m", HOUR + 30 * MINUTE],
    ["1D", DAY],
  ])("parses %s", (value, expected) => {
    expect(parseDuration(value, "--since")).toBe(expected);
  });

  test.each(["", "1", "h", "1.5h", "-1h", "1y", "1h 30m", "yesterday"])(
    "rejects %p naming the flag",
    (value) => {
      expect(() => parseDuration(value, "--since")).toThrow(`Invalid --since value "${value}"`);
    },
  );

  test.each(["0s", "0h0m"])("rejects the zero duration %s", (value) => {
    expect(() => parseDuration(value, "--since")).toThrow("longer than zero");
  });
});

describe("parseTimestamp", () => {
  test.each([
    ["Unix milliseconds", "1762702200000", 1_762_702_200_000],
    ["a date, as midnight UTC", "2026-11-09", Date.UTC(2026, 10, 9)],
    ["a UTC date-time", "2026-11-09T15:30:00Z", Date.UTC(2026, 10, 9, 15, 30)],
    ["a date-time without an offset, as UTC", "2026-11-09T15:30:00", Date.UTC(2026, 10, 9, 15, 30)],
    ["a date-time with a space and no seconds", "2026-11-09 15:30", Date.UTC(2026, 10, 9, 15, 30)],
    ["fractional seconds", "2026-11-09T15:30:00.250Z", Date.UTC(2026, 10, 9, 15, 30, 0, 250)],
    ["an offset", "2026-11-09T10:30:00-05:00", Date.UTC(2026, 10, 9, 15, 30)],
  ])("parses %s", (_name, value, expected) => {
    expect(parseTimestamp(value, "--from")).toBe(expected);
  });

  test.each(["", "yesterday", "11/09/2026", "2026-11-09T25:00:00Z", "2026-13-01", "1.5"])(
    "rejects %p naming the flag",
    (value) => {
      expect(() => parseTimestamp(value, "--to")).toThrow(`Invalid --to value "${value}"`);
    },
  );
});

describe("resolveTimeRange", () => {
  const now = Date.UTC(2026, 10, 9, 18, 0);

  test("sends no bounds without time flags", () => {
    expect(resolveTimeRange({}, now)).toEqual({ after: undefined, before: undefined });
  });

  test("turns --since into now minus the duration", () => {
    expect(resolveTimeRange({ since: HOUR }, now)).toEqual({
      after: now - HOUR,
      before: undefined,
    });
  });

  test("passes --from and --to through", () => {
    expect(resolveTimeRange({ from: 1_000, to: 2_000 }, now)).toEqual({
      after: 1_000,
      before: 2_000,
    });
  });

  test("combines --since with --to", () => {
    expect(resolveTimeRange({ since: HOUR, to: now }, now)).toEqual({
      after: now - HOUR,
      before: now,
    });
  });

  test("rejects --since with --from", () => {
    expect(() => resolveTimeRange({ since: HOUR, from: 1_000 }, now)).toThrow(
      "Pass either --since or --from, not both.",
    );
  });

  test.each([
    ["--from", { from: 2_000, to: 1_000 }],
    ["--since", { since: HOUR, to: now - 2 * HOUR }],
  ])("rejects a %s that starts after --to", (flag, options) => {
    expect(() => resolveTimeRange(options, now)).toThrow(`${flag} must start before --to.`);
  });
});
