import { test, expect, describe } from "bun:test";
import { formatSkillsPromptMessage, resolveUpstreamSkills } from "./skills.ts";

const DEFAULTS = [
  "clerk-setup",
  "clerk-custom-ui",
  "clerk-backend-api",
  "clerk-orgs",
  "clerk-testing",
  "clerk-webhooks",
];

describe("resolveUpstreamSkills", () => {
  test("returns the 6 defaults when no framework is detected", () => {
    expect(resolveUpstreamSkills(undefined)).toEqual(DEFAULTS);
  });

  test("appends the framework skill for a known dep", () => {
    expect(resolveUpstreamSkills("next")).toEqual([...DEFAULTS, "clerk-nextjs-patterns"]);
  });

  test("returns just the defaults for express (clerk-backend-api is already a default)", () => {
    expect(resolveUpstreamSkills("express")).toEqual(DEFAULTS);
  });

  test("returns just the defaults for fastify (clerk-backend-api is already a default)", () => {
    expect(resolveUpstreamSkills("fastify")).toEqual(DEFAULTS);
  });

  test("returns just the defaults for an unknown framework dep", () => {
    expect(resolveUpstreamSkills("svelte")).toEqual(DEFAULTS);
  });
});

describe("formatSkillsPromptMessage", () => {
  test("summarizes without a framework skill", () => {
    expect(formatSkillsPromptMessage(undefined)).toBe(
      "Install agent skills? (clerk core + features)",
    );
  });

  test("strips the clerk- prefix from the framework skill", () => {
    expect(formatSkillsPromptMessage("clerk-nextjs-patterns")).toBe(
      "Install agent skills? (clerk core + features + nextjs-patterns)",
    );
  });
});
