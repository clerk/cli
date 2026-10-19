import { afterEach, beforeEach, expect, test } from "bun:test";
import { claimDestination, describeClaimDestination } from "./claim-prompt.ts";

const savedApiKey = process.env.CLERK_PLATFORM_API_KEY;

beforeEach(() => {
  delete process.env.CLERK_PLATFORM_API_KEY;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = savedApiKey;
});

test("a stored session's account is the destination when no API key is set", () => {
  expect(claimDestination({ email: "jane@example.com" })).toEqual({
    kind: "account",
    email: "jane@example.com",
  });
});

// Every Platform API call, the claim included, uses the key when it's set.
test("the API key's workspace is the destination whenever the key is set, even with a session", () => {
  process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform_key";

  expect(claimDestination({ email: "jane@example.com" })).toEqual({ kind: "api_key" });
  expect(claimDestination(null)).toEqual({ kind: "api_key" });
});

test("no destination without a session or an API key", () => {
  expect(claimDestination(null)).toBeUndefined();
});

// Nothing checks that Clerk's account-info reply includes an email.
test("a session without an email is still a destination, worded as the signed-in account", () => {
  const destination = claimDestination({});

  expect(destination).toEqual({ kind: "account", email: undefined });
  expect(describeClaimDestination(destination!)).toBe("the account you're signed in to");
});

test.each([
  {
    destination: { kind: "account", email: "jane@example.com" } as const,
    text: "jane@example.com's account",
  },
  {
    destination: { kind: "api_key" } as const,
    text: "the workspace your `CLERK_PLATFORM_API_KEY` belongs to",
  },
])("describes $destination.kind as $text", ({ destination, text }) => {
  expect(describeClaimDestination(destination)).toBe(text);
});
