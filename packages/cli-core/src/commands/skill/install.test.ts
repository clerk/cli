import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSkillsArgs, withStagedClerkCliSkill } from "./install.ts";

describe("buildSkillsArgs", () => {
  const skills = ["clerk", "clerk-setup", "clerk-nextjs-patterns"];
  const upstream = "clerk/skills";

  test("interactive mode: no -y or -g, lets skills CLI take over", () => {
    const args = buildSkillsArgs(upstream, skills, true, false);
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
    const args = buildSkillsArgs(upstream, skills, false, false);
    expect(args).toContain("-y");
    expect(args).toContain("-g");
    expect(args).not.toContain("--agent");
  });

  test("never passes --agent (lets skills CLI auto-detect)", () => {
    expect(buildSkillsArgs(upstream, skills, true, false)).not.toContain("--agent");
    expect(buildSkillsArgs(upstream, skills, false, false)).not.toContain("--agent");
  });

  test("empty skillNames omits --skill flags (used for the clerk-cli source)", () => {
    const stageDir = "/tmp/clerk-cli-skill-abc";
    const args = buildSkillsArgs(stageDir, [], true, true);
    expect(args).toEqual(["skills", "add", stageDir, "--copy"]);
    expect(args).not.toContain("--skill");
  });

  test("copy=true appends --copy flag (required for the staged clerk-cli dir)", () => {
    const args = buildSkillsArgs("/tmp/clerk-cli-skill-xyz", [], false, true);
    expect(args).toContain("--copy");
    // --copy should trail -y / -g, not replace them.
    expect(args).toContain("-y");
    expect(args).toContain("-g");
  });
});

describe("withStagedClerkCliSkill", () => {
  test("stages all bundled files into a fresh temp dir and cleans up after", async () => {
    let observed: { dir: string; files: Record<string, string> } | null = null;

    await withStagedClerkCliSkill(async (dir) => {
      const files = {
        "clerk-cli/SKILL.md": await readFile(join(dir, "clerk-cli/SKILL.md"), "utf-8"),
        "clerk-cli/references/auth.md": await readFile(
          join(dir, "clerk-cli/references/auth.md"),
          "utf-8",
        ),
        "clerk-cli/references/recipes.md": await readFile(
          join(dir, "clerk-cli/references/recipes.md"),
          "utf-8",
        ),
        "clerk-cli/references/agent-mode.md": await readFile(
          join(dir, "clerk-cli/references/agent-mode.md"),
          "utf-8",
        ),
      };
      observed = { dir, files };

      const entry = await stat(join(dir, "clerk-cli"));
      expect(entry.isDirectory()).toBe(true);
    });

    expect(observed).not.toBeNull();
    const { dir, files } = observed!;

    // Every file has some content (bundled imports are non-empty).
    for (const [rel, content] of Object.entries(files)) {
      expect(content.length).toBeGreaterThan(0);
      expect(content, rel).toMatch(/\S/);
    }

    // SKILL.md should at least contain the YAML frontmatter marker.
    expect(files["clerk-cli/SKILL.md"]).toContain("---");

    // Temp dir is removed once the callback returns.
    expect(existsSync(dir)).toBe(false);
  });

  test("propagates callback errors after cleaning up", async () => {
    let capturedDir: string | null = null;

    await expect(
      withStagedClerkCliSkill(async (dir) => {
        capturedDir = dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(capturedDir).not.toBeNull();
    expect(existsSync(capturedDir!)).toBe(false);
  });
});
