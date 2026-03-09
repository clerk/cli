import { test, expect, describe } from "bun:test";
import { normalizeGitRemoteUrl } from "./git.ts";

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
