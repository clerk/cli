import { test, expect, describe } from "bun:test";
import { isEnabled, isRequired, enabledAttributes } from "./attributes.ts";
import type { UserSettingsJSON } from "@clerk/shared/types";

const settings = {
  attributes: {
    email_address: { enabled: true, required: false, used_for_first_factor: true },
    password: { enabled: true, required: true, used_for_first_factor: false },
    username: { enabled: false, required: false, used_for_first_factor: false },
  },
} as unknown as UserSettingsJSON;

describe("attributes helpers", () => {
  test("isEnabled returns true for enabled attributes", () => {
    expect(isEnabled(settings, "email_address")).toBe(true);
    expect(isEnabled(settings, "username")).toBe(false);
  });

  test("isRequired returns true only when required and enabled", () => {
    expect(isRequired(settings, "password")).toBe(true);
    expect(isRequired(settings, "email_address")).toBe(false);
    expect(isRequired(settings, "username")).toBe(false);
  });

  test("isEnabled returns false for unknown attribute", () => {
    expect(isEnabled(settings, "phone_number")).toBe(false);
  });

  test("enabledAttributes returns only enabled attribute names", () => {
    expect(enabledAttributes(settings)).toEqual(["email_address", "password"]);
  });
});
