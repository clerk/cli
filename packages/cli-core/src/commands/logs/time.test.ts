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
    ["the smallest accepted Unix milliseconds (2020-01-01)", "1577836800000", 1_577_836_800_000],
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
    ["current Unix seconds", "1762702200", "--from"],
    ["Unix seconds with leading zeros", "01762702200", "--from"],
    ["Unix seconds as --to", "1762702200", "--to"],
    ["the last millisecond of 2019", "1577836799999", "--from"],
    ["a millisecond value in 1975", "157766400000", "--from"],
    ["zero", "0", "--to"],
    ["zero with leading zeros", "000", "--to"],
    ["a small number", "1000", "--to"],
  ])("rejects %s as earlier than 2020", (_name, value, flag) => {
    const error = captureError(() => parseTimestamp(value, flag));
    expect(error.message).toBe(
      `Invalid ${flag} value "${value}". ${flag} takes Unix milliseconds or an ISO 8601 date-time, like 1762702200000 or 2026-11-09T15:30:00Z.`,
    );
    expect(error).toMatchObject({ exitCode: EXIT_CODE.USAGE });
  });

  test.each([
    ["a date", "2019-12-31", Date.UTC(2019, 11, 31)],
    ["a date-time", "1975-01-01T00:00:00Z", Date.UTC(1975, 0, 1)],
  ])("still accepts %s before 2020", (_name, value, expected) => {
    expect(parseTimestamp(value, "--from")).toBe(expected);
  });
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
