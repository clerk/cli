import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSkillsArgs, renderSkillVersionPlaceholder, withStagedClerkSkill } from "./install.ts";

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

  test("empty skillNames omits --skill flags (used for the clerk source)", () => {
    const stageDir = "/tmp/clerk-skill-abc";
    const args = buildSkillsArgs(stageDir, [], true, true);
    expect(args).toEqual(["skills", "add", stageDir, "--copy"]);
    expect(args).not.toContain("--skill");
  });

  test("copy=true appends --copy flag (required for the staged clerk dir)", () => {
    const args = buildSkillsArgs("/tmp/clerk-skill-xyz", [], false, true);
    expect(args).toContain("--copy");
    // --copy should trail -y / -g, not replace them.
    expect(args).toContain("-y");
    expect(args).toContain("-g");
  });
});

describe("withStagedClerkSkill", () => {
  test("stages all bundled files into a fresh temp dir and cleans up after", async () => {
    let observed: { dir: string; files: Record<string, string> } | null = null;

    await withStagedClerkSkill(undefined, async (dir) => {
      const files = {
        "clerk/SKILL.md": await readFile(join(dir, "clerk/SKILL.md"), "utf-8"),
        "clerk/references/auth.md": await readFile(join(dir, "clerk/references/auth.md"), "utf-8"),
        "clerk/references/recipes.md": await readFile(
          join(dir, "clerk/references/recipes.md"),
          "utf-8",
        ),
        "clerk/references/agent-mode.md": await readFile(
          join(dir, "clerk/references/agent-mode.md"),
          "utf-8",
        ),
      };
      observed = { dir, files };

      const entry = await stat(join(dir, "clerk"));
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
    expect(files["clerk/SKILL.md"]).toContain("---");

    // Temp dir is removed once the callback returns.
    expect(existsSync(dir)).toBe(false);
  });

  test("propagates callback errors after cleaning up", async () => {
    let capturedDir: string | null = null;

    await expect(
      withStagedClerkSkill(undefined, async (dir) => {
        capturedDir = dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(capturedDir).not.toBeNull();
    expect(existsSync(capturedDir!)).toBe(false);
  });
});

describe("withStagedClerkSkill version rendering", () => {
  test("substitutes CLI_VERSION into the staged SKILL.md", async () => {
    await withStagedClerkSkill("4.5.6", async (stageDir) => {
      const skill = await readFile(join(stageDir, "clerk/SKILL.md"), "utf8");
      expect(skill).not.toContain("{{CLI_VERSION}}");
    });
  });

  test("passes undefined through as `latest`", async () => {
    await withStagedClerkSkill(undefined, async (stageDir) => {
      const skill = await readFile(join(stageDir, "clerk/SKILL.md"), "utf8");
      expect(skill).not.toContain("{{CLI_VERSION}}");
    });
  });
});

describe("renderSkillVersionPlaceholder", () => {
  test("replaces {{CLI_VERSION}} with the provided version", () => {
    const result = renderSkillVersionPlaceholder("Pinned: `bunx clerk@{{CLI_VERSION}}`.", "1.2.3");
    expect(result).toBe("Pinned: `bunx clerk@1.2.3`.");
  });

  test("replaces every occurrence, not just the first", () => {
    const result = renderSkillVersionPlaceholder(
      "v={{CLI_VERSION}} and again v={{CLI_VERSION}}",
      "9.9.9",
    );
    expect(result).toBe("v=9.9.9 and again v=9.9.9");
  });

  test("falls back to `latest` when version is undefined", () => {
    const result = renderSkillVersionPlaceholder(
      "Install: `npx -y clerk@{{CLI_VERSION}}`.",
      undefined,
    );
    expect(result).toBe("Install: `npx -y clerk@latest`.");
  });

  test("falls back to `latest` when version is the dev sentinel", () => {
    const result = renderSkillVersionPlaceholder("v={{CLI_VERSION}}", "0.0.0-dev");
    expect(result).toBe("v=latest");
  });

  test("returns content unchanged when no placeholder is present", () => {
    const input = "No placeholder here.";
    expect(renderSkillVersionPlaceholder(input, "1.2.3")).toBe(input);
  });
});
