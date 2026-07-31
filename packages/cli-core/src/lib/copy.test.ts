import { test, expect, describe } from "bun:test";
import { keylessCopy } from "./copy.ts";

describe("apiReachableKeysLine", () => {
  test.each([
    ["organization_settings", "`clerk api /organization_settings`"],
    ["protect", "`clerk api /protect`"],
  ])("names a single key's own clerk api example (%s)", (key, example) => {
    const line = keylessCopy.apiReachableKeysLine([key]);
    expect(line).toContain(`${key} is already reachable`);
    expect(line).toContain(example);
  });

  test("names every key's own clerk api example when multiple keys are reachable", () => {
    const line = keylessCopy.apiReachableKeysLine(["protect", "organization_settings"]);
    expect(line).toContain("protect, organization_settings are already reachable");
    expect(line).toContain("`clerk api /protect`");
    expect(line).toContain("`clerk api /organization_settings`");
    expect(line).toContain(" or ");
  });
});
