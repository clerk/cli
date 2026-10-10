import { test, expect, describe } from "bun:test";
import { buildUserAgent } from "./user-agent.ts";

describe("buildUserAgent", () => {
  test("starts with Clerk-CLI/<version>", () => {
    expect(buildUserAgent({})).toMatch(/^Clerk-CLI\/\S+ /);
  });

  test("includes Bun/<bun-version> and platform-arch", () => {
    const ua = buildUserAgent({});
    expect(ua).toContain(`Bun/${Bun.version}`);
    expect(ua).toContain(`${process.platform}-${process.arch}`);
  });

  test("appends ci segment when CI env is set", () => {
    const ua = buildUserAgent({ CI: "1" });
    expect(ua).toMatch(/; ci\)$/);
  });

  test("omits ci segment when CI env is unset", () => {
    const ua = buildUserAgent({});
    expect(ua).not.toMatch(/; ci\)/);
  });

  test("uses only printable ASCII characters", () => {
    expect(buildUserAgent({})).toMatch(/^[\x20-\x7e]+$/);
  });

  test("appends an AIAgent segment when an agent is detected", () => {
    const ua = buildUserAgent({ CLAUDECODE: "1" });
    expect(ua).toMatch(/; AIAgent\/claude_code\)$/);
  });

  test("ci and AIAgent segments compose inside the parens", () => {
    expect(buildUserAgent({ CI: "1", CLAUDECODE: "1" })).toMatch(/; ci; AIAgent\/claude_code\)$/);
  });

  test("no AIAgent segment when no agent env is present", () => {
    expect(buildUserAgent({})).not.toContain("AIAgent/");
  });

  test("agentToken: false omits the segment even when an agent is detected", () => {
    expect(buildUserAgent({ CLAUDECODE: "1" }, { agentToken: false })).not.toContain("AIAgent/");
  });
});
