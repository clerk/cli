import { test, expect, describe } from "bun:test";
import { EXIT_CODE } from "../../lib/errors.ts";
import { parseDuration, parseTimestamp, resolveTimeRange } from "./time.ts";

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the call to throw");
}

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
    ["the smallest accepted Unix milliseconds", "100000000000", 100_000_000_000],
    ["Unix milliseconds with leading zeros", "0001762702200000", 1_762_702_200_000],
    ["Unix milliseconds with surrounding spaces", " 1762702200000 ", 1_762_702_200_000],
    ["a date, as midnight UTC", "2026-11-09", Date.UTC(2026, 10, 9)],
    ["a UTC date-time", "2026-11-09T15:30:00Z", Date.UTC(2026, 10, 9, 15, 30)],
    ["a date-time without an offset, as UTC", "2026-11-09T15:30:00", Date.UTC(2026, 10, 9, 15, 30)],
    ["a date-time with a space and no seconds", "2026-11-09 15:30", Date.UTC(2026, 10, 9, 15, 30)],
    ["fractional seconds", "2026-11-09T15:30:00.250Z", Date.UTC(2026, 10, 9, 15, 30, 0, 250)],
    ["an offset", "2026-11-09T10:30:00-05:00", Date.UTC(2026, 10, 9, 15, 30)],
    ["an offset that crosses midnight", "2026-11-09T23:30:00-05:00", Date.UTC(2026, 10, 10, 4, 30)],
    ["a leap day", "2028-02-29", Date.UTC(2028, 1, 29)],
    ["a leap day date-time", "2028-02-29T12:00:00Z", Date.UTC(2028, 1, 29, 12)],
  ])("parses %s", (_name, value, expected) => {
    expect(parseTimestamp(value, "--from")).toBe(expected);
  });

  test.each([
    "",
    "yesterday",
    "11/09/2026",
    "2026-11-09T25:00:00Z",
    "2026-13-01",
    "1.5",
    "2026-02-30",
    "2026-04-31",
    "2027-02-29",
    "2026-02-31T10:00",
    "2026-02-30T10:00:00-05:00",
    "-1762702200000",
    "-1",
  ])("rejects %p naming the flag", (value) => {
    expect(() => parseTimestamp(value, "--to")).toThrow(`Invalid --to value "${value}"`);
  });

  test.each([
    ["current Unix seconds", "1762702200", "1762702200000"],
    ["the largest rejected number", "99999999999", "99999999999000"],
    ["the smallest number read as seconds", "100000000", "100000000000"],
    ["Unix seconds with leading zeros", "01762702200", "1762702200000"],
  ])("rejects %s as Unix seconds, suggesting milliseconds", (_name, value, suggestion) => {
    const error = captureError(() => parseTimestamp(value, "--from"));
    expect(error.message).toBe(
      `Invalid --from value "${value}". It looks like Unix seconds, but --from takes Unix milliseconds. Use ${suggestion} or an ISO 8601 date-time like 2026-11-09T15:30:00Z.`,
    );
    expect(error).toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  test.each(["0", "000", "1000", "99999999"])(
    "rejects %p as too early to be a log time",
    (value) => {
      const error = captureError(() => parseTimestamp(value, "--to"));
      expect(error.message).toStartWith(
        `Invalid --to value "${value}". As Unix milliseconds it's before March 1973`,
      );
      expect(error.message).not.toContain("Unix seconds");
      expect(error).toMatchObject({ exitCode: EXIT_CODE.USAGE });
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
