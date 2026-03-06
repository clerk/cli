import { resolve } from "node:path";

const $ = Bun.$;

interface GitRepoInfo {
  toplevel: string;
  commonDir: string;
  normalizedRemote?: string;
}

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

  // Fetch remote URL (non-blocking since rev-parse already succeeded)
  const remoteResult = await $`git remote get-url origin`.quiet().nothrow();
  const rawRemote = remoteResult.exitCode === 0 ? remoteResult.text().trim() : undefined;

  cached = {
    toplevel,
    commonDir: resolve(toplevel, commonDir),
    normalizedRemote: rawRemote ? normalizeGitRemoteUrl(rawRemote) : undefined,
  };
  return cached;
}

export async function getGitRepoRoot(): Promise<string | undefined> {
  const info = await getGitRepoInfo();
  return info?.toplevel;
}

export async function getGitRepoIdentifier(): Promise<string | undefined> {
  const info = await getGitRepoInfo();
  return info?.commonDir;
}

export async function getGitNormalizedRemote(): Promise<string | undefined> {
  const info = await getGitRepoInfo();
  return info?.normalizedRemote;
}

export function normalizeGitRemoteUrl(raw: string): string {
  let url = raw.trim();

  // Handle SCP-style: git@host:org/repo.git (username may contain +)
  const scpMatch = url.match(/^[\w.+-]+@([^:]+):(.+)$/);
  if (scpMatch) {
    url = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    // Handle protocol URLs: https://, ssh://, git://
    url = url.replace(/^[a-z+]+:\/\//, "");
    // Strip user@
    url = url.replace(/^[^@/]+@/, "");
    // Strip port
    url = url.replace(/:\d+(?=\/)/, "");
  }

  // Strip trailing .git
  url = url.replace(/\.git$/, "");
  // Strip trailing slash
  url = url.replace(/\/$/, "");

  return url.toLowerCase();
}