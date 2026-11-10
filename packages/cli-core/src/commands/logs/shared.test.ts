import { test, expect, describe } from "bun:test";
import { formatLogLocation, formatLogTime, pad, type Log } from "./shared.ts";

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
