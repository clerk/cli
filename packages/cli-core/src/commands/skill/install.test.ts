import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  buildSkillsArgs,
  installClerkSkillCore,
  renderSkillVersionPlaceholder,
  resolveClerkSkillOverride,
  withStagedClerkSkill,
} from "./install.ts";
import type { Runner } from "../../lib/runners.ts";

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

const ALL_BUNDLED_FILES = [
  "clerk/SKILL.md",
  "clerk/references/auth.md",
  "clerk/references/recipes.md",
  "clerk/references/agent-mode.md",
] as const;

describe("withStagedClerkSkill version rendering", () => {
  test("substitutes CLI_VERSION in every staged file", async () => {
    await withStagedClerkSkill("4.5.6", async (stageDir) => {
      for (const rel of ALL_BUNDLED_FILES) {
        const content = await readFile(join(stageDir, rel), "utf8");
        expect(content, rel).not.toContain("{{CLI_VERSION}}");
      }
    });
  });

  test("resolves undefined version to `latest` in every staged file", async () => {
    await withStagedClerkSkill(undefined, async (stageDir) => {
      for (const rel of ALL_BUNDLED_FILES) {
        const content = await readFile(join(stageDir, rel), "utf8");
        expect(content, rel).not.toContain("{{CLI_VERSION}}");
      }
    });
  });
});

describe("bundled SKILL.md frontmatter", () => {
  // Regression guard: the upstream `skills` CLI parses SKILL.md frontmatter as
  // strict YAML and silently drops skills whose frontmatter fails to parse.
  // An unquoted `: ` inside the description (e.g. `raw HTTP: it handles`)
  // triggers "Nested mappings are not allowed in compact mappings" and makes
  // `clerk skill install` fail with "No valid skills found".
  test("parses as YAML with name and description strings", async () => {
    await withStagedClerkSkill(undefined, async (stageDir) => {
      const content = await readFile(join(stageDir, "clerk/SKILL.md"), "utf8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
      expect(frontmatter, "SKILL.md must have YAML frontmatter").toBeDefined();

      const parsed = YAML.parse(frontmatter!);
      expect(typeof parsed.name).toBe("string");
      expect(typeof parsed.description).toBe("string");
      expect(parsed.name.length).toBeGreaterThan(0);
      expect(parsed.description.length).toBeGreaterThan(0);
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

describe("installClerkSkillCore wiring", () => {
  const runner: Runner = {
    id: "bunx",
    binary: "bunx",
    prefixArgs: [],
    display: "bunx",
  };

  const originalOverride = process.env.CLERK_SKILL_SOURCE;
  const spawnSpy = spyOn(Bun, "spawn");

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.CLERK_SKILL_SOURCE;
    else process.env.CLERK_SKILL_SOURCE = originalOverride;
    spawnSpy.mockReset();
  });

  function stubSpawnSuccess() {
    spawnSpy.mockImplementation(
      () => ({ exited: Promise.resolve(0) }) as unknown as ReturnType<typeof Bun.spawn>,
    );
  }

  test("routes to override with copy:false when CLERK_SKILL_SOURCE is set", async () => {
    process.env.CLERK_SKILL_SOURCE = "clerk/cli";
    stubSpawnSuccess();

    const ok = await installClerkSkillCore(runner, process.cwd(), false);
    expect(ok).toBe(true);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const call = spawnSpy.mock.calls[0];
    if (!call) throw new Error("spawn was not called");
    const argv = call[0] as string[];
    expect(argv[0]).toBe("bunx");
    expect(argv.slice(1, 4)).toEqual(["skills", "add", "clerk/cli"]);
    expect(argv).not.toContain("--copy");
    expect(argv).not.toContain("--skill");
  });

  test("routes to withStagedClerkSkill with copy:true when unset", async () => {
    delete process.env.CLERK_SKILL_SOURCE;
    stubSpawnSuccess();

    const ok = await installClerkSkillCore(runner, process.cwd(), false);
    expect(ok).toBe(true);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const call = spawnSpy.mock.calls[0];
    if (!call) throw new Error("spawn was not called");
    const argv = call[0] as string[];
    expect(argv[0]).toBe("bunx");
    expect(argv.slice(1, 3)).toEqual(["skills", "add"]);
    const source = argv[3];
    if (!source) throw new Error("spawn argv missing source arg");
    expect(source.startsWith(tmpdir())).toBe(true);
    expect(source).toContain("clerk-skill-");
    expect(argv).toContain("--copy");
    expect(argv).not.toContain("--skill");
  });
});

describe("resolveClerkSkillOverride", () => {
  test("returns undefined when env var is unset", () => {
    expect(resolveClerkSkillOverride({})).toBeUndefined();
  });

  test("returns undefined when env var is empty or whitespace", () => {
    expect(resolveClerkSkillOverride({ CLERK_SKILL_SOURCE: "" })).toBeUndefined();
    expect(resolveClerkSkillOverride({ CLERK_SKILL_SOURCE: "   " })).toBeUndefined();
  });

  test("returns trimmed value when env var is set", () => {
    expect(resolveClerkSkillOverride({ CLERK_SKILL_SOURCE: "clerk/cli" })).toBe("clerk/cli");
    expect(resolveClerkSkillOverride({ CLERK_SKILL_SOURCE: "  /tmp/my-skill  " })).toBe(
      "/tmp/my-skill",
    );
    expect(
      resolveClerkSkillOverride({
        CLERK_SKILL_SOURCE: "https://github.com/me/fork/tree/wip/skills/clerk",
      }),
    ).toBe("https://github.com/me/fork/tree/wip/skills/clerk");
  });
});
