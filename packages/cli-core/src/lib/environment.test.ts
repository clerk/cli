import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getPlapiBaseUrl, warnIfPlatformApiUrlOverride } from "./environment.ts";
import { setMode } from "../mode.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

describe("warnIfPlatformApiUrlOverride", () => {
  const captured = useCaptureLog();
  const original = process.env.CLERK_PLATFORM_API_URL;

  beforeEach(() => {
    setMode("human");
    delete process.env.CLERK_PLATFORM_API_URL;
  });

  afterEach(() => {
    setMode("human");
    if (original === undefined) delete process.env.CLERK_PLATFORM_API_URL;
    else process.env.CLERK_PLATFORM_API_URL = original;
  });

  test("warns in human mode when the override differs from the active env URL", () => {
    process.env.CLERK_PLATFORM_API_URL = "https://api.staging.example.com";
    warnIfPlatformApiUrlOverride();
    expect(captured.err).toContain("CLERK_PLATFORM_API_URL");
    expect(captured.err).toContain("production");
  });

  test("does not warn when no override is set", () => {
    warnIfPlatformApiUrlOverride();
    expect(captured.err).not.toContain("CLERK_PLATFORM_API_URL");
  });

  test("does not warn when the override equals the active env URL", () => {
    const profileUrl = getPlapiBaseUrl(); // no override set → active env URL
    process.env.CLERK_PLATFORM_API_URL = profileUrl;
    warnIfPlatformApiUrlOverride();
    expect(captured.err).not.toContain("CLERK_PLATFORM_API_URL");
  });

  test("stays silent in agent mode to avoid corrupting machine-readable output", () => {
    setMode("agent");
    process.env.CLERK_PLATFORM_API_URL = "https://api.staging.example.com";
    warnIfPlatformApiUrlOverride();
    expect(captured.err).not.toContain("CLERK_PLATFORM_API_URL");
  });
});
