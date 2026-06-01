import { test, expect, describe } from "bun:test";
import { buildSkillsArgs } from "./skills.ts";

describe("buildSkillsArgs", () => {
  const skills = ["clerk", "clerk-setup", "clerk-nextjs-patterns"];
  const upstream = "clerk/skills";

  test("interactive mode: no -y or -g, lets skills CLI take over", () => {
    const args = buildSkillsArgs(upstream, skills, true);
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
    expect(args).not.toContain("--copy");
  });

  test("non-interactive mode: includes -y and -g for global auto-detect", () => {
    const args = buildSkillsArgs(upstream, skills, false);
    expect(args).toContain("-y");
    expect(args).toContain("-g");
    expect(args).not.toContain("--agent");
  });

  test("never passes --agent (lets skills CLI auto-detect)", () => {
    expect(buildSkillsArgs(upstream, skills, true)).not.toContain("--agent");
    expect(buildSkillsArgs(upstream, skills, false)).not.toContain("--agent");
  });

  test("empty skillNames omits --skill flags", () => {
    const args = buildSkillsArgs("clerk/skills", [], true);
    expect(args).toEqual(["skills", "add", "clerk/skills"]);
    expect(args).not.toContain("--skill");
  });
});
