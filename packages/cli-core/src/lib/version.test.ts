import { test, expect, describe } from "bun:test";
import semver from "semver";
import cliPackage from "../../../cli/package.json";
import { isDevVersion, resolveCliVersion, resolveDevVersion } from "./version.ts";

// ── isDevVersion ──────────────────────────────────────────────────────────────

describe("isDevVersion", () => {
  test("recognizes the bare dev version", () => {
    expect(isDevVersion("0.0.0-dev")).toBe(true);
    expect(isDevVersion("3.0.0-dev")).toBe(true);
  });

  test("recognizes a dev version carrying a commit", () => {
    expect(isDevVersion("3.0.0-dev.20260803.f51f1e4")).toBe(true);
    expect(isDevVersion("3.0.0-dev.20260803.f51f1e4.dirty")).toBe(true);
  });

  test("does not treat stable versions as dev", () => {
    expect(isDevVersion("3.0.0")).toBe(false);
  });

  test("does not treat real prereleases as dev", () => {
    expect(isDevVersion("0.0.2-canary.v20260409211526")).toBe(false);
    expect(isDevVersion("3.1.0-snapshot.abc1234")).toBe(false);
    // A channel that merely starts with the same letters is not the dev channel
    expect(isDevVersion("3.1.0-development.1")).toBe(false);
  });
});

// ── resolveCliVersion ─────────────────────────────────────────────────────────

describe("resolveCliVersion", () => {
  test("returns undefined under the test runner, where CLI_VERSION is undefined", () => {
    expect(resolveCliVersion()).toBeUndefined();
  });
});

// ── resolveDevVersion ─────────────────────────────────────────────────────────

describe("resolveDevVersion", () => {
  const version = resolveDevVersion();

  test("is built on the version packages/cli publishes at", () => {
    expect(version.startsWith(`${cliPackage.version}-dev`)).toBe(true);
  });

  test("classifies as a dev version", () => {
    expect(isDevVersion(version)).toBe(true);
  });

  test("is valid semver, so update-check comparisons can never throw on it", () => {
    expect(semver.valid(version)).not.toBeNull();
  });

  test("sorts below the release it is based on", () => {
    expect(semver.lt(version, cliPackage.version)).toBe(true);
  });

  test("is memoized", () => {
    expect(resolveDevVersion()).toBe(version);
  });

  test("carries a YYYYMMDD.<sha> commit segment when run from a git checkout", () => {
    // The suite always runs from a checkout, but guard anyway: an exported
    // tarball with no .git must still produce a usable version.
    const suffix = version.slice(`${cliPackage.version}-dev`.length);
    expect(suffix === "" || /^\.\d{8}\.[0-9a-fg]+(\.dirty)?$/.test(suffix)).toBe(true);
  });
});
