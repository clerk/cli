import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fixtures } from "../test/e2e/fixtures.manifest.ts";
import type { FixtureConfig } from "../test/e2e/lib/types.ts";
import { normalizeProjectSymlinks, refreshFixtures } from "./refresh-e2e-fixtures.ts";

describe("react-router fixture scaffold command", () => {
  test("disables git initialization", () => {
    expect(fixtures["react-router"].scaffoldCmd).toContain("--no-git-init");
  });

  test("pins React Router fixture packages to v7", () => {
    expect(fixtures["react-router"].packageJsonOverrides).toEqual({
      dependencies: {
        "@react-router/node": "7.18.2",
        "@react-router/serve": "7.18.2",
        "react-router": "7.18.2",
      },
      devDependencies: {
        "@react-router/dev": "7.18.2",
      },
    });
  });
});

describe("normalizeProjectSymlinks", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "normalize-symlinks-test-"));
    tempDirs.push(dir);
    await Bun.write(join(dir, "AGENTS.md"), "# agents\n");
    return dir;
  }

  test("rewrites an absolute in-project link as relative", async () => {
    const dir = await makeProject();
    await symlink(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));

    const dropped = await normalizeProjectSymlinks(dir);

    expect(dropped).toEqual([]);
    expect(await readlink(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await Bun.file(join(dir, "CLAUDE.md")).text()).toBe("# agents\n");
  });

  test("rewrites an absolute link from a nested directory", async () => {
    const dir = await makeProject();
    await mkdir(join(dir, "docs"), { recursive: true });
    await symlink(join(dir, "AGENTS.md"), join(dir, "docs/CLAUDE.md"));

    await normalizeProjectSymlinks(dir);

    expect(await readlink(join(dir, "docs/CLAUDE.md"))).toBe(join("..", "AGENTS.md"));
    expect(await Bun.file(join(dir, "docs/CLAUDE.md")).text()).toBe("# agents\n");
  });

  test("leaves an already-relative link untouched", async () => {
    const dir = await makeProject();
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"));

    const dropped = await normalizeProjectSymlinks(dir);

    expect(dropped).toEqual([]);
    expect(await readlink(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  test("drops a link pointing outside the project", async () => {
    const dir = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), "normalize-symlinks-outside-"));
    tempDirs.push(outside);
    await Bun.write(join(outside, "AGENTS.md"), "# elsewhere\n");
    await symlink(join(outside, "AGENTS.md"), join(dir, "CLAUDE.md"));

    const dropped = await normalizeProjectSymlinks(dir);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toStartWith("CLAUDE.md -> ");
    expect(await Bun.file(join(dir, "CLAUDE.md")).exists()).toBe(false);
  });

  test("drops a dangling link", async () => {
    const dir = await makeProject();
    await symlink("/tmp/clerk-fixture-astro-c7nceg/AGENTS.md", join(dir, "CLAUDE.md"));

    const dropped = await normalizeProjectSymlinks(dir);

    expect(dropped).toHaveLength(1);
    expect(await Bun.file(join(dir, "CLAUDE.md")).exists()).toBe(false);
  });

  test("leaves no absolute symlink behind anywhere in the tree", async () => {
    const dir = await makeProject();
    await mkdir(join(dir, "docs"), { recursive: true });
    await symlink(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
    await symlink(join(dir, "AGENTS.md"), join(dir, "docs/CLAUDE.md"));
    await symlink("AGENTS.md", join(dir, "RULES.md"));

    await normalizeProjectSymlinks(dir);

    const links = ["CLAUDE.md", "docs/CLAUDE.md", "RULES.md"];
    const targets = await Promise.all(links.map((link) => readlink(join(dir, link))));
    expect(targets.every((target) => !isAbsolute(target))).toBe(true);
  });
});

describe("refreshFixtures", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("attempts every requested scaffold before reporting failures", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "refresh-fixtures-test-"));
    tempDirs.push(tmpRoot);

    const attempts: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const config = {
      scaffoldCmd: ["fake-scaffold"],
      clerkSdk: "@clerk/react",
      buildCmd: ["fake-build"],
      devCmd: ["fake-dev"],
    } satisfies FixtureConfig;

    try {
      const result = await refreshFixtures({
        entries: [
          ["first", config],
          ["second", config],
        ],
        fixturesDir: join(tmpRoot, "fixtures"),
        tmpRoot,
        runScaffold: async (_command, cwd) => {
          attempts.push(basename(cwd));
          return {
            exitCode: 1,
            stderr: `${basename(cwd)} failed`,
            stdout: "",
          };
        },
      });

      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toStartWith("clerk-fixture-first-");
      expect(attempts[1]).toStartWith("clerk-fixture-second-");
      expect(result.failedFixtures).toEqual(["first", "second"]);
      expect(errorSpy.mock.calls.at(-1)?.[0]).toBe("❌ Fixture refresh failed for: first, second");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
