import { test, expect, describe, afterEach } from "bun:test";
import { buildUserAgent } from "./user-agent.ts";

describe("buildUserAgent", () => {
  const originalCi = process.env.CI;
  afterEach(() => {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  });

  test("starts with Clerk-CLI/<version>", () => {
    expect(buildUserAgent()).toMatch(/^Clerk-CLI\/\S+ /);
  });

  test("includes Bun/<bun-version> and platform-arch", () => {
    const ua = buildUserAgent();
    expect(ua).toContain(`Bun/${Bun.version}`);
    expect(ua).toContain(`${process.platform}-${process.arch}`);
  });

  test("appends ci segment when CI env is set", () => {
    process.env.CI = "1";
    expect(buildUserAgent()).toMatch(/; ci\)$/);
  });

  test("omits ci segment when CI env is unset", () => {
    delete process.env.CI;
    expect(buildUserAgent()).not.toMatch(/; ci\)/);
  });

  test("uses only printable ASCII characters", () => {
    expect(buildUserAgent()).toMatch(/^[\x20-\x7e]+$/);
  });
});
