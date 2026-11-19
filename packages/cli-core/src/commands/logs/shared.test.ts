import { test, expect, describe } from "bun:test";
import { formatLogLocation, formatLogRange, formatLogTime, pad, type Log } from "./shared.ts";

function makeLog(device: NonNullable<Log["event_context"]>["device"]): Log {
  return {
    object: "log",
    id: "log_1",
    event_time: 0,
    type: "user.created",
    event_context: { device },
  };
}

describe("formatLogTime", () => {
  const now = new Date(2026, 10, 9, 18, 0, 0);

  test("shows only the time for a log from today", () => {
    expect(formatLogTime(new Date(2026, 10, 9, 7, 5, 3).getTime(), now)).toBe("07:05:03");
  });

  test("prefixes the date for a log from another day", () => {
    expect(formatLogTime(new Date(2026, 10, 8, 23, 59, 59).getTime(), now)).toBe(
      "2026-11-08 23:59:59",
    );
  });
});

describe("formatLogRange", () => {
  const now = new Date(2026, 10, 9, 18, 0, 0);
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 10, day, hour, minute, 0).getTime();

  test.each([
    ["only times when both ends are today", at(9, 7, 0), at(9, 17, 55), "07:00:00 – 17:55:00"],
    [
      "the date on both ends when the range starts on another day",
      at(8, 18, 5),
      at(9, 18, 5),
      "2026-11-08 18:05:00 – 2026-11-09 18:05:00",
    ],
    [
      "the date on both ends when the whole range is on another day",
      at(7, 9, 0),
      at(7, 10, 0),
      "2026-11-07 09:00:00 – 2026-11-07 10:00:00",
    ],
  ])("shows %s", (_name, from, to, expected) => {
    expect(formatLogRange(from, to, now)).toBe(expected);
  });
});

describe("formatLogLocation", () => {
  test.each([
    [
      "city and country code",
      { location: { city: "Lima", country_code: "PE", country: "Peru" } },
      "Lima, PE",
    ],
    ["country when there is no code", { location: { country: "Peru" } }, "Peru"],
    ["the IP address without a location", { ip_address: "203.0.113.7" }, "203.0.113.7"],
    ["nothing without a device", undefined, ""],
  ])("%s", (_name, device, expected) => {
    expect(formatLogLocation(makeLog(device))).toBe(expected);
  });
});

describe("pad", () => {
  test("aligns every column but the last", () => {
    expect(
      pad([
        ["A", "BB", "C"],
        ["AAA", "B", "CCCC"],
      ]),
    ).toEqual(["A    BB  C", "AAA  B   CCCC"]);
  });
});
