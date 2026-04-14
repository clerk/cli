import { test, expect, describe } from "bun:test";
import { buildSkillsArgs, installSkills } from "./skills.ts";
import { testRoot } from "../../test/lib/test-root.ts";
import { createFakeSystem } from "../../lib/system.fake.ts";
import { createRunners, KNOWN_RUNNERS, type Runner } from "../../lib/runners.ts";

describe("buildSkillsArgs", () => {
  const skills = ["clerk", "clerk-setup", "clerk-nextjs-patterns"];

  test("interactive mode: no -y or -g, lets skills CLI take over", () => {
    const args = buildSkillsArgs(skills, true);
    expect(args).toEqual([
      "skills",
      "add",
      "clerk/skills",
      "--skill",
      "clerk",
      "--skill",
      "clerk-setup",
      "--skill",
      "clerk-nextjs-patterns",
    ]);
    expect(args).not.toContain("-y");
    expect(args).not.toContain("-g");
    expect(args).not.toContain("--agent");
  });

  test("non-interactive mode: includes -y and -g for global auto-detect", () => {
    const args = buildSkillsArgs(skills, false);
    expect(args).toContain("-y");
    expect(args).toContain("-g");
    expect(args).not.toContain("--agent");
  });

  test("never passes --agent (lets skills CLI auto-detect)", () => {
    expect(buildSkillsArgs(skills, true)).not.toContain("--agent");
    expect(buildSkillsArgs(skills, false)).not.toContain("--agent");
  });
});

function runner(id: Runner["id"]): Runner {
  return KNOWN_RUNNERS.find((r) => r.id === id)!;
}

describe("installSkills runner detection", () => {
  test("non-interactive: uses preferred runner without prompting", async () => {
    const system = createFakeSystem({ binaries: { bunx: "/u/bunx" } });
    system.queueSpawn({ exitCode: 0 });
    const runners = createRunners(system);
    const deps = testRoot({
      mode: { isHuman: () => false },
      system,
      runners,
      log: { info: () => {}, warn: () => {}, success: () => {}, blank: () => {} },
    });

    await installSkills(deps, "/project", "next", "bun", true);

    // First (and only) spawn should be `bunx skills add clerk/skills ...`.
    expect(system.calls.spawn.length).toBe(1);
    expect(system.calls.spawn[0]?.cmd.slice(0, 4)).toEqual([
      "bunx",
      "skills",
      "add",
      "clerk/skills",
    ]);
  });

  test("interactive with multiple runners: prompts select with available set", async () => {
    const system = createFakeSystem({
      binaries: { bunx: "/u/bunx", npx: "/u/npx", pnpm: "/u/pnpm" },
    });
    system.queueSpawn({ exitCode: 0 });
    const runners = createRunners(system);

    type SelectArgs = { choices: Array<{ name: string; value: Runner }>; default?: Runner };
    let selectArgs: SelectArgs | null = null;
    const deps = testRoot({
      mode: { isHuman: () => true },
      system,
      runners,
      prompts: {
        confirm: async () => true,
        select: (async (opts: SelectArgs) => {
          selectArgs = opts;
          return runner("pnpm");
        }) as never,
      },
      log: { info: () => {}, warn: () => {}, success: () => {}, blank: () => {} },
    });

    await installSkills(deps, "/project", "next", "pnpm", false);

    expect(selectArgs).not.toBeNull();
    const ids = (selectArgs!.choices as Array<{ value: Runner }>).map((c) => c.value.id);
    expect(ids).toEqual(["bunx", "npx", "pnpm"]);
    expect(selectArgs!.default?.id).toBe("pnpm");
    // Chosen runner determines final spawn command.
    expect(system.calls.spawn[0]?.cmd.slice(0, 2)).toEqual(["pnpm", "dlx"]);
  });

  test("no runners available: warns with pm-suggested command and does not spawn", async () => {
    const system = createFakeSystem(); // no binaries
    const runners = createRunners(system);
    const warnings: string[] = [];
    const deps = testRoot({
      mode: { isHuman: () => false },
      system,
      runners,
      log: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        success: () => {},
        blank: () => {},
      },
    });

    await installSkills(deps, "/project", "next", "yarn", true);

    expect(system.calls.spawn.length).toBe(0);
    expect(warnings.some((m) => m.includes("yarn dlx skills add"))).toBe(true);
  });

  test("spawn throws: soft-fails with a fallback warning", async () => {
    const system = createFakeSystem({ binaries: { bunx: "/u/bunx" } });
    system.queueSpawn({ throw: new Error("ENOENT") });
    const runners = createRunners(system);
    const warnings: string[] = [];
    const deps = testRoot({
      mode: { isHuman: () => false },
      system,
      runners,
      log: {
        info: () => {},
        warn: (msg: string) => warnings.push(msg),
        success: () => {},
        blank: () => {},
      },
    });

    await installSkills(deps, "/project", "next", "bun", true);

    expect(warnings.some((m) => m.includes("install manually"))).toBe(true);
  });
});
