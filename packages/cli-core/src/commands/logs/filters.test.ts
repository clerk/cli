import { test, expect, describe } from "bun:test";
import { resolveFilters, type LogFilterOptions } from "./filters.ts";

describe("resolveFilters", () => {
  test("sends nothing without filter flags", () => {
    expect(resolveFilters({})).toEqual([]);
  });

  test.each<[string, LogFilterOptions, Array<[string, string]>]>([
    ["--type", { type: "user.created" }, [["type", "user.created"]]],
    ["--type with a trailing wildcard", { type: "sign_in.*" }, [["type", "sign_in.*"]]],
    ["--user", { user: "user_123" }, [["user_id", "user_123"]]],
    ["--identifier", { identifier: "ada@example.com" }, [["identifier", "ada@example.com"]]],
    ["--actor", { actor: "user_123" }, [["actor", "user_123"]]],
    ["--subject", { subject: "sess_123" }, [["subject", "sess_123"]]],
    ["--session", { session: "sess_123" }, [["session_id", "sess_123"]]],
    ["--client", { client: "client_123" }, [["client_id", "client_123"]]],
    ["--ip", { ip: "203.0.113.7" }, [["ip_address", "203.0.113.7"]]],
    [
      "--trace",
      { trace: "0123456789abcdef0123456789abcdef" },
      [["trace_id", "0123456789abcdef0123456789abcdef"]],
    ],
    ["--impersonator", { impersonator: "user_456" }, [["impersonator_user_id", "user_456"]]],
    [
      "--payload-filter",
      { type: "sms.failed", payloadFilter: ["phone_number=+15555550100"] },
      [
        ["type", "sms.failed"],
        ["payload_filter[phone_number]", "+15555550100"],
      ],
    ],
    [
      "repeated --payload-filter, keeping an = inside the value",
      { type: "user.created", payloadFilter: ["user_id=user_1", "a.b.c.d=x=y"] },
      [
        ["type", "user.created"],
        ["payload_filter[user_id]", "user_1"],
        ["payload_filter[a.b.c.d]", "x=y"],
      ],
    ],
    [
      "--fields, trimmed",
      { type: "user.created", fields: "user_id, email_address" },
      [
        ["type", "user.created"],
        ["payload_fields", "user_id,email_address"],
      ],
    ],
    [
      "--match any",
      { actor: "user_1", match: "any" },
      [
        ["actor", "user_1"],
        ["filter_match", "any"],
      ],
    ],
    ["--match all, the API default", { actor: "user_1", match: "all" }, [["actor", "user_1"]]],
    ["--end-user-only", { endUserOnly: true }, [["end_user_facing_only", "true"]]],
  ])("maps %s", (_name, options, expected) => {
    expect(resolveFilters(options)).toEqual(expected);
  });

  test.each<[string, LogFilterOptions, string]>([
    [
      "--user with --identifier",
      { user: "user_1", identifier: "a@b.co" },
      "--user can't be combined with --identifier.",
    ],
    [
      "--user with --actor",
      { user: "user_1", actor: "user_2" },
      "--user can't be combined with --actor.",
    ],
    [
      "--user with --subject",
      { user: "user_1", subject: "user_2" },
      "--user can't be combined with --subject.",
    ],
    [
      "--identifier with --actor",
      { identifier: "a@b.co", actor: "user_2" },
      "--identifier can't be combined with --actor.",
    ],
    [
      "--identifier with --subject",
      { identifier: "a@b.co", subject: "user_2" },
      "--identifier can't be combined with --subject.",
    ],
    [
      "--user that isn't a user ID",
      { user: "ada@example.com" },
      'Invalid --user value "ada@example.com"',
    ],
    ["--user that is only the prefix", { user: "user_" }, 'Invalid --user value "user_"'],
    [
      "--identifier that is a user ID",
      { identifier: "user_1" },
      "Use --user user_1 to filter by user ID.",
    ],
    ["--type with a leading wildcard", { type: "*.created" }, 'Invalid --type value "*.created"'],
    [
      "--type with a middle wildcard",
      { type: "sign*.created" },
      'Invalid --type value "sign*.created"',
    ],
    ["--type with two wildcards", { type: "sign_in.**" }, 'Invalid --type value "sign_in.**"'],
    [
      "--payload-filter without --type",
      { payloadFilter: ["user_id=user_1"] },
      "--payload-filter requires --type.",
    ],
    ["--fields without --type", { fields: "user_id" }, "--fields requires --type."],
    [
      "--payload-filter without =",
      { type: "t", payloadFilter: ["user_id"] },
      'Invalid --payload-filter "user_id". Use <path>=<value>',
    ],
    [
      "--payload-filter with an empty path",
      { type: "t", payloadFilter: ["=x"] },
      'The path before "=" can\'t be empty.',
    ],
    [
      "--payload-filter with an empty value",
      { type: "t", payloadFilter: ["user_id="] },
      'The value after "=" can\'t be empty.',
    ],
    [
      "--payload-filter with an empty segment",
      { type: "t", payloadFilter: ["a..b=x"] },
      'Invalid --payload-filter path "a..b"',
    ],
    [
      "--payload-filter deeper than 4 levels",
      { type: "t", payloadFilter: ["a.b.c.d.e=x"] },
      "at most 4 levels deep",
    ],
    [
      "--payload-filter with a value over 256 characters",
      { type: "t", payloadFilter: [`user_id=${"x".repeat(257)}`] },
      "at most 256 characters",
    ],
    [
      "more than 10 --payload-filter",
      { type: "t", payloadFilter: Array.from({ length: 11 }, (_, i) => `f${i}=x`) },
      "Pass at most 10 --payload-filter paths.",
    ],
    [
      "a repeated --payload-filter path",
      { type: "t", payloadFilter: ["user_id=a", "user_id=b"] },
      '--payload-filter names "user_id" more than once.',
    ],
    ["an empty --fields", { type: "t", fields: " , " }, "--fields needs at least one payload path"],
    ["--fields deeper than 4 levels", { type: "t", fields: "a.b.c.d.e" }, "at most 4 levels deep"],
    [
      "more than 10 --fields",
      { type: "t", fields: Array.from({ length: 11 }, (_, i) => `f${i}`).join(",") },
      "Pass at most 10 --fields paths.",
    ],
    [
      "a repeated --fields path",
      { type: "t", fields: "user_id,user_id" },
      '--fields names "user_id" more than once.',
    ],
    [
      "--fields with --match any",
      { type: "t", fields: "user_id", match: "any" },
      "--fields can't be combined with --match any",
    ],
  ])("rejects %s", (_name, options, message) => {
    expect(() => resolveFilters(options)).toThrow(message);
  });

  test("accepts a 256-character payload filter value", () => {
    const value = "x".repeat(256);
    expect(resolveFilters({ type: "t", payloadFilter: [`user_id=${value}`] })).toContainEqual([
      "payload_filter[user_id]",
      value,
    ]);
  });
});
