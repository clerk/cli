import { describe, expect, test } from "bun:test";
import { PASSWORD_HASHERS } from "./types.ts";
import { userSchema } from "./validator.ts";

const base = { userId: "user_1", email: "a@example.com" };

describe("userSchema identifiers", () => {
  const IDENTIFIER_CASES = [
    ["email", { email: "a@example.com" }, true],
    ["emailAddresses array", { emailAddresses: ["a@example.com"] }, true],
    ["unverified email", { unverifiedEmailAddresses: ["a@example.com"] }, true],
    ["phone", { phone: "+15555550100" }, true],
    ["unverified phone", { unverifiedPhoneNumbers: ["+15555550100"] }, true],
    ["username", { username: "alice" }, true],
    ["nothing", {}, false],
    ["empty email array", { email: [] }, false],
    ["empty username", { username: "" }, false],
  ] as const;

  test.each([...IDENTIFIER_CASES])(
    "accepts a user identified by %s: %p -> %p",
    (_label, fields, ok) => {
      expect(userSchema.safeParse({ userId: "user_1", ...fields }).success).toBe(ok);
    },
  );

  test("reports the identifier failure against the email path", () => {
    const result = userSchema.safeParse({ userId: "user_1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["email"]);
  });
});

describe("userSchema passwords", () => {
  test("rejects a password without a hasher", () => {
    const result = userSchema.safeParse({ ...base, password: "digest" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["passwordHasher"]);
  });

  test("accepts a password with a valid hasher", () => {
    expect(
      userSchema.safeParse({ ...base, password: "digest", passwordHasher: "bcrypt" }).success,
    ).toBe(true);
  });

  test("rejects an unknown hasher", () => {
    expect(
      userSchema.safeParse({ ...base, password: "digest", passwordHasher: "rot13" }).success,
    ).toBe(false);
  });

  test.each([...PASSWORD_HASHERS])("accepts the %s hasher", (hasher) => {
    expect(
      userSchema.safeParse({ ...base, password: "digest", passwordHasher: hasher }).success,
    ).toBe(true);
  });
});

describe("userSchema field types", () => {
  const FIELD_CASES = [
    ["valid email", { email: "a@example.com" }, true],
    ["malformed email", { email: "not-an-email" }, false],
    ["email array with one bad entry", { email: ["a@example.com", "nope"] }, false],
    ["userId missing", { userId: undefined }, false],
    ["valid createdAt", { createdAt: "2024-01-01T00:00:00Z" }, true],
    ["unparseable createdAt", { createdAt: "yesterday" }, false],
    ["integer org limit", { createOrganizationsLimit: 3 }, true],
    ["fractional org limit", { createOrganizationsLimit: 1.5 }, false],
    ["metadata object", { publicMetadata: { plan: "pro" } }, true],
    ["metadata string", { publicMetadata: "pro" }, false],
    ["backupCodes array", { backupCodes: ["a", "b"] }, true],
  ] as const;

  test.each([...FIELD_CASES])("%s -> %p", (_label, fields, ok) => {
    expect(userSchema.safeParse({ ...base, ...fields }).success).toBe(ok);
  });
});
