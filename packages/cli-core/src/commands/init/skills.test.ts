import { test, expect, describe, mock, spyOn, beforeEach, afterAll } from "bun:test";
import { setMode } from "../../mode.ts";
import * as telemetryMod from "../../lib/telemetry.ts";

// Stub the layer that would shell out to `bunx skills add`, so these tests
// exercise installSkills' branching without spawning a subprocess.
let runnerStub: () => unknown = () => ({ id: "bunx", display: "bunx" });
let addSucceeds = true;
mock.module("../../lib/skills.ts", () => ({
  resolveSkillsRunner: async () => runnerStub(),
  runSkillsAdd: async () => addSucceeds,
}));

let confirmAnswer = true;
mock.module("../../lib/prompts.ts", () => ({ confirm: async () => confirmAnswer }));

const { formatSkillsPromptMessage, resolveUpstreamSkills, installSkills } =
  await import("./skills.ts");

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

  test("appends both the setup and patterns skills for expo", () => {
    expect(resolveUpstreamSkills("expo")).toEqual([
      ...DEFAULTS,
      "clerk-expo",
      "clerk-expo-patterns",
    ]);
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
    expect(formatSkillsPromptMessage(["clerk-expo", "clerk-expo-patterns"])).toBe(
      "Install agent skills? (clerk-cli + core + features + expo + expo-patterns)",
    );
  });
});

describe("installSkills telemetry", () => {
  const recorded = spyOn(telemetryMod, "setTelemetrySkills");

  beforeEach(() => {
    recorded.mockClear();
    runnerStub = () => ({ id: "bunx", display: "bunx" });
    addSucceeds = true;
    confirmAnswer = true;
    setMode("agent");
  });

  afterAll(() => recorded.mockRestore());

  test("records the resolved skill list when the install succeeds", async () => {
    await installSkills("/tmp/proj", "next", "bun", true);
    expect(recorded).toHaveBeenCalledWith([...resolveUpstreamSkills("next")], "installed");
  });

  test("records a failed install rather than staying silent", async () => {
    addSucceeds = false;
    await installSkills("/tmp/proj", undefined, "bun", true);
    expect(recorded.mock.calls[0]?.[1]).toBe("failed");
  });

  // No runner on PATH is a different story from a user saying no, and the
  // warehouse could not tell them apart before this.
  test("records runner_missing when no package runner is available", async () => {
    runnerStub = () => undefined;
    await installSkills("/tmp/proj", undefined, "bun", true);
    expect(recorded.mock.calls[0]?.[1]).toBe("runner_missing");
  });

  test("records a decline, and never reaches the runner", async () => {
    setMode("human");
    confirmAnswer = false;
    runnerStub = () => {
      throw new Error("runner must not be probed after a decline");
    };
    await installSkills("/tmp/proj", undefined, "bun", false);
    expect(recorded.mock.calls[0]?.[1]).toBe("declined");
  });
});
