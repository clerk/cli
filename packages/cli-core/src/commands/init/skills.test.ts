import { test, expect, describe } from "bun:test";
import { formatSkillsPromptMessage, getFrameworkSkills, resolveUpstreamSkills } from "./skills.ts";

const DEFAULTS = [
  "clerk-cli",
  "clerk-setup",
  "clerk-custom-ui",
  "clerk-backend-api",
  "clerk-orgs",
  "clerk-testing",
  "clerk-webhooks",
];

describe("resolveUpstreamSkills", () => {
  test("returns the 7 defaults when no framework is detected", () => {
    expect(resolveUpstreamSkills(undefined)).toEqual(DEFAULTS);
  });

  test("appends the framework skill for a known dep", () => {
    expect(resolveUpstreamSkills("next")).toEqual([...DEFAULTS, "clerk-nextjs-patterns"]);
  });

  test("appends the clerk-expo skill for expo", () => {
    expect(resolveUpstreamSkills("expo")).toEqual([...DEFAULTS, "clerk-expo"]);
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
  test("summarizes without framework skills", () => {
    expect(formatSkillsPromptMessage([])).toBe(
      "Install agent skills? (clerk-cli + core + features)",
    );
  });

  test("strips the clerk- prefix from the framework skill", () => {
    expect(formatSkillsPromptMessage(["clerk-nextjs-patterns"])).toBe(
      "Install agent skills? (clerk-cli + core + features + nextjs-patterns)",
    );
  });

  test("lists every framework skill when a dep maps to more than one", () => {
    expect(formatSkillsPromptMessage(["clerk-first", "clerk-second"])).toBe(
      "Install agent skills? (clerk-cli + core + features + first + second)",
    );
  });

  test("lists only expo for an expo project", () => {
    expect(formatSkillsPromptMessage(getFrameworkSkills("expo"))).toBe(
      "Install agent skills? (clerk-cli + core + features + expo)",
    );
  });
});
