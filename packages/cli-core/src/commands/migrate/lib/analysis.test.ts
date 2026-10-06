import { describe, expect, test } from "bun:test";
import { analyzeFields, hasValue } from "./analysis.ts";

describe("hasValue", () => {
  test.each([
    ["a string", "x", true],
    ["zero", 0, true],
    ["false", false, true],
    ["a populated array", ["a"], true],
    ["an object", {}, true],
    ["an empty string", "", false],
    ["an empty array", [], false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("treats %s as present: %p", (_label, value, expected) => {
    expect(hasValue(value)).toBe(expected);
  });
});

describe("analyzeFields", () => {
  test("returns zeroed counts for an empty file", () => {
    const result = analyzeFields([]);
    expect(result.totalUsers).toBe(0);
    expect(result.identifiers.hasAnyIdentifier).toBe(0);
    expect(result.fieldCounts).toEqual({});
  });

  test("counts each identifier kind separately", () => {
    const result = analyzeFields([
      { userId: "1", email: "a@x.dev" },
      { userId: "2", unverifiedEmailAddresses: ["b@x.dev"] },
      { userId: "3", phone: "+15555550100" },
      { userId: "4", unverifiedPhoneNumbers: ["+15555550101"] },
      { userId: "5", username: "carol" },
    ]);

    expect(result.identifiers).toMatchObject({
      verifiedEmails: 1,
      unverifiedEmails: 1,
      verifiedPhones: 1,
      unverifiedPhones: 1,
      username: 1,
      hasAnyIdentifier: 5,
    });
  });

  test("counts emailAddresses towards verified emails", () => {
    const result = analyzeFields([{ userId: "1", emailAddresses: ["a@x.dev"] }]);
    expect(result.identifiers.verifiedEmails).toBe(1);
  });

  test("counts a user with several identifiers once", () => {
    const result = analyzeFields([
      { userId: "1", email: "a@x.dev", phone: "+15555550100", username: "ada" },
    ]);
    expect(result.identifiers.hasAnyIdentifier).toBe(1);
    expect(result.identifiers.verifiedEmails).toBe(1);
    expect(result.identifiers.verifiedPhones).toBe(1);
  });

  // These users cannot be imported under any instance configuration, which is
  // what makes the count worth surfacing separately.
  test("counts users carrying no identifier at all", () => {
    const result = analyzeFields([
      { userId: "1", email: "a@x.dev" },
      { userId: "2", firstName: "Nobody" },
      { userId: "3" },
    ]);
    expect(result.totalUsers).toBe(3);
    expect(result.identifiers.hasAnyIdentifier).toBe(1);
  });

  test("counts the analyzed non-identifier fields", () => {
    const result = analyzeFields([
      { userId: "1", email: "a@x.dev", firstName: "Ada", password: "d", totpSecret: "s" },
      { userId: "2", email: "b@x.dev", firstName: "Grace" },
      { userId: "3", email: "c@x.dev", lastName: "Hopper" },
    ]);
    expect(result.fieldCounts).toEqual({
      firstName: 2,
      lastName: 1,
      password: 1,
      totpSecret: 1,
    });
  });

  test("omits fields no user carries, rather than reporting them as zero", () => {
    const result = analyzeFields([{ userId: "1", email: "a@x.dev" }]);
    expect("password" in result.fieldCounts).toBe(false);
  });

  test("does not count an empty value as present", () => {
    const result = analyzeFields([{ userId: "1", email: "a@x.dev", firstName: "", lastName: [] }]);
    expect(result.fieldCounts.firstName).toBeUndefined();
    expect(result.fieldCounts.lastName).toBeUndefined();
  });
});
