import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntry, normalizeGitRemoteUrl } from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  test("normalizes SSH SCP-style URL", () => {
    expect(normalizeGitRemoteUrl("git@github.com:org/repo.git")).toBe("github.com/org/repo");
  });

  test("normalizes HTTPS URL with .git", () => {
    expect(normalizeGitRemoteUrl("https://github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  test("normalizes HTTPS URL without .git", () => {
    expect(normalizeGitRemoteUrl("https://github.com/org/repo")).toBe("github.com/org/repo");
  });

  test("normalizes ssh:// protocol URL", () => {
    expect(normalizeGitRemoteUrl("ssh://git@github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  test("normalizes ssh:// with port", () => {
    expect(normalizeGitRemoteUrl("ssh://git@github.com:22/org/repo.git")).toBe(
      "github.com/org/repo",
    );
  });

  test("normalizes HTTPS with user@", () => {
    expect(normalizeGitRemoteUrl("https://user@github.com/org/repo.git")).toBe(
      "github.com/org/repo",
    );
  });

  test("normalizes git:// protocol", () => {
    expect(normalizeGitRemoteUrl("git://github.com/org/repo.git")).toBe("github.com/org/repo");
  });

  test("lowercases everything", () => {
    expect(normalizeGitRemoteUrl("git@GitHub.COM:MyOrg/MyRepo.git")).toBe(
      "github.com/myorg/myrepo",
    );
  });

  test("strips trailing slash", () => {
    expect(normalizeGitRemoteUrl("https://github.com/org/repo/")).toBe("github.com/org/repo");
  });

  test("handles self-hosted GitLab URL", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.company.com:team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });

  test("handles Bitbucket SSH URL", () => {
    expect(normalizeGitRemoteUrl("git@bitbucket.org:org/repo.git")).toBe("bitbucket.org/org/repo");
  });

  test("handles ssh:// with custom port", () => {
    expect(normalizeGitRemoteUrl("ssh://git@git.example.com:2222/org/repo.git")).toBe(
      "git.example.com/org/repo",
    );
  });

  test("handles whitespace around URL", () => {
    expect(normalizeGitRemoteUrl("  https://github.com/org/repo.git  ")).toBe(
      "github.com/org/repo",
    );
  });
});

describe("ensureGitignoreEntry", () => {
  let tempDir: string;
  let gitignorePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-git-test-"));
    gitignorePath = join(tempDir, ".gitignore");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates .gitignore when none exists", async () => {
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe(".clerk/\n");
  });

  test("appends the entry when it is not listed", async () => {
    await Bun.write(gitignorePath, "node_modules\n");
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe("node_modules\n.clerk/\n");
  });

  test("adds a newline before appending when the file lacks a trailing one", async () => {
    await Bun.write(gitignorePath, "node_modules");
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe("node_modules\n.clerk/\n");
  });

  test.each([".clerk/", "/.clerk/", "/.clerk", ".clerk", ".clerk/*", ".clerk/**", "  /.clerk/  "])(
    "leaves .gitignore unchanged when %p is already listed",
    async (existing) => {
      const content = `node_modules\n# clerk configuration (can include secrets)\n${existing}\n`;
      await Bun.write(gitignorePath, content);
      await ensureGitignoreEntry(tempDir, ".clerk/");
      expect(await Bun.file(gitignorePath).text()).toBe(content);
    },
  );

  test("does not treat a commented-out entry as listed", async () => {
    await Bun.write(gitignorePath, "# .clerk/\n");
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe("# .clerk/\n.clerk/\n");
  });

  test("does not treat a negated entry as listed", async () => {
    await Bun.write(gitignorePath, "!.clerk/\n");
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe("!.clerk/\n.clerk/\n");
  });

  test("does not treat a nested path as listed", async () => {
    await Bun.write(gitignorePath, "apps/web/.clerk/\n");
    await ensureGitignoreEntry(tempDir, ".clerk/");
    expect(await Bun.file(gitignorePath).text()).toBe("apps/web/.clerk/\n.clerk/\n");
  });
});
