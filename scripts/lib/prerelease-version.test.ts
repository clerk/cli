import { expect, test } from "bun:test";
import { replaceChangesetsCommit, toSemverSafeCommitIdentifier } from "./prerelease-version.ts";

test("preserves alphanumeric short shas", () => {
  expect(toSemverSafeCommitIdentifier("bba6a98")).toBe("bba6a98");
});

test("prefixes numeric-only short shas", () => {
  expect(toSemverSafeCommitIdentifier("0405146")).toBe("g0405146");
});

test("replaces full commit with semver-safe short sha", () => {
  expect(
    replaceChangesetsCommit("1.0.1-canary.0123456789abcdef0123456789abcdef01234567", "0405146"),
  ).toBe("1.0.1-canary.g0405146");
});
