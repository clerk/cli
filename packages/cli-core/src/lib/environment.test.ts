import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { isPlatformApiUrlOverridden } from "./environment.ts";

describe("isPlatformApiUrlOverridden", () => {
  const original = process.env.CLERK_PLATFORM_API_URL;

  beforeEach(() => {
    delete process.env.CLERK_PLATFORM_API_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CLERK_PLATFORM_API_URL;
    else process.env.CLERK_PLATFORM_API_URL = original;
  });

  test("returns overridden=true with URLs when the override differs from the active env URL", () => {
    process.env.CLERK_PLATFORM_API_URL = "https://api.staging.example.com";
    const result = isPlatformApiUrlOverridden();
    expect(result.overridden).toBe(true);
    if (!result.overridden) return;
    expect(result.overrideUrl).toBe("https://api.staging.example.com");
    expect(result.profileUrl).toBe("https://api.clerk.com");
    expect(result.envName).toBe("production");
  });

  test("returns overridden=false when no override is set", () => {
    const result = isPlatformApiUrlOverridden();
    expect(result.overridden).toBe(false);
  });

  test("returns overridden=false when the override equals the active env URL", () => {
    process.env.CLERK_PLATFORM_API_URL = "https://api.clerk.com";
    const result = isPlatformApiUrlOverridden();
    expect(result.overridden).toBe(false);
  });

  test("returns overridden=false when URLs differ only by trailing slash", () => {
    process.env.CLERK_PLATFORM_API_URL = "https://api.clerk.com/";
    const result = isPlatformApiUrlOverridden();
    expect(result.overridden).toBe(false);
  });
});
