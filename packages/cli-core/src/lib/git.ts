import { resolve } from "node:path";

const $ = Bun.$;

interface GitRepoInfo {
  toplevel: string;
  commonDir: string;
  normalizedRemote?: string;
}

export function normalizeGitRemoteUrl(raw: string): string {
  let url = raw.trim();

  const scpMatch = url.match(/^[\w.+-]+@([^:]+):(.+)$/);
  if (scpMatch) {
    url = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    url = url.replace(/^[a-z+]+:\/\//, "");
    url = url.replace(/^[^@/]+@/, "");
    url = url.replace(/:\d+(?=\/)/, "");
  }

  url = url.replace(/\.git$/, "");
  url = url.replace(/\/$/, "");

  return url.toLowerCase();
}

export interface Git {
  getGitRepoRoot(): Promise<string | undefined>;
  getGitRepoIdentifier(): Promise<string | undefined>;
  getGitNormalizedRemote(): Promise<string | undefined>;
  normalizeGitRemoteUrl(raw: string): string;
}

export function createGit(): Git {
  let cached: GitRepoInfo | undefined | null = null;

  async function getGitRepoInfo(): Promise<GitRepoInfo | undefined> {
    if (cached !== null) return cached ?? undefined;

    const result = await $`git rev-parse --show-toplevel --git-common-dir`.quiet().nothrow();
    if (result.exitCode !== 0) {
      cached = undefined;
      return undefined;
    }

    const lines = result.text().trim().split("\n");
    const toplevel = lines[0];
    const commonDir = lines[1];
    if (!toplevel || !commonDir) {
      cached = undefined;
      return undefined;
    }

    const remoteResult = await $`git remote get-url origin`.quiet().nothrow();
    const rawRemote = remoteResult.exitCode === 0 ? remoteResult.text().trim() : undefined;

    cached = {
      toplevel,
      commonDir: resolve(toplevel, commonDir),
      normalizedRemote: rawRemote ? normalizeGitRemoteUrl(rawRemote) : undefined,
    };
    return cached;
  }

  return {
    getGitRepoRoot: async () => (await getGitRepoInfo())?.toplevel,
    getGitRepoIdentifier: async () => (await getGitRepoInfo())?.commonDir,
    getGitNormalizedRemote: async () => (await getGitRepoInfo())?.normalizedRemote,
    normalizeGitRemoteUrl,
  };
}
