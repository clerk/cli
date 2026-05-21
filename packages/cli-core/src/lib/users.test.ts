import { test, expect, describe } from "bun:test";
import { CliError, ERROR_CODE, EXIT_CODE } from "./errors.ts";
import {
  buildCreateUserPayload,
  buildUpdateUserPayload,
  mergeUsersPayload,
  parseUsersPayload,
  redactUsersDisplayPayload,
} from "./users.ts";

describe("users helpers", () => {
  test("buildCreateUserPayload maps curated flags to Clerk API payload", () => {
    expect(
      buildCreateUserPayload({
        email: "alice@example.com",
        password: "Password123",
        firstName: "Alice",
      }),
    ).toEqual({
      email_address: ["alice@example.com"],
      password: "Password123",
      first_name: "Alice",
    });
  });

  test("buildUpdateUserPayload maps update flags to Clerk API fields", () => {
    expect(buildUpdateUserPayload({ firstName: "Alice", externalId: "ext_123" })).toEqual({
      first_name: "Alice",
      external_id: "ext_123",
    });
  });

  test("mergeUsersPayload lets curated flags override JSON payload fields", () => {
    expect(
      mergeUsersPayload({ first_name: "Json" }, buildCreateUserPayload({ firstName: "Flag" })),
    ).toEqual({
      first_name: "Flag",
    });
  });

  test("parseUsersPayload returns the parsed object for a valid JSON string", () => {
    expect(parseUsersPayload('{"email_address":["alice@example.com"]}')).toEqual({
      email_address: ["alice@example.com"],
    });
  });

  test("parseUsersPayload rejects invalid JSON with an invalid_json CliError", () => {
    let error: unknown;
    try {
      parseUsersPayload("not json");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.INVALID_JSON);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
  });

  test.each(['["email@example.com"]', '"just a string"', "42", "null"])(
    "parseUsersPayload rejects non-object JSON: %s",
    (input) => {
      let error: unknown;
      try {
        parseUsersPayload(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(ERROR_CODE.INVALID_JSON);
    },
  );

  test("redactUsersDisplayPayload masks passwords, codes, and private/unsafe metadata", () => {
    expect(
      redactUsersDisplayPayload({
        email_address: ["alice@example.com"],
        password: "Password123",
        code: "123456",
        private_metadata: { secret: "hidden" },
        unsafe_metadata: { token: "abc" },
        public_metadata: { role: "admin" },
      }),
    ).toEqual({
      email_address: ["alice@example.com"],
      password: "[REDACTED]",
      code: "[REDACTED]",
      private_metadata: "[REDACTED]",
      unsafe_metadata: "[REDACTED]",
      public_metadata: { role: "admin" },
    });
  });

  test("redactUsersDisplayPayload recurses into arrays and nested objects", () => {
    expect(
      redactUsersDisplayPayload({
        users: [{ password: "one" }, { password: "two" }],
      }),
    ).toEqual({
      users: [{ password: "[REDACTED]" }, { password: "[REDACTED]" }],
    });
  });
});
