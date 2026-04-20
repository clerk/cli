import { resolve } from "node:path";

const $ = Bun.$;

interface GitRepoInfo {
  toplevel: string;
  commonDir: string;
  normalizedRemote?: string;
}

const cache = new Map<string, GitRepoInfo | undefined>();

async function getGitRepoInfo(cwd?: string): Promise<GitRepoInfo | undefined> {
  const key = cwd ?? process.cwd();
  if (cache.has(key)) return cache.get(key);

  const result = await $`git rev-parse --show-toplevel --git-common-dir`.cwd(key).quiet().nothrow();
  if (result.exitCode !== 0) {
    cache.set(key, undefined);
    return undefined;
  }

  const lines = result.text().trim().split("\n");
  const toplevel = lines[0];
  const commonDir = lines[1];
  if (!toplevel || !commonDir) {
    cache.set(key, undefined);
    return undefined;
  }

  // Fetch remote URL (non-blocking since rev-parse already succeeded)
  const remoteResult = await $`git remote get-url origin`.cwd(key).quiet().nothrow();
  const rawRemote = remoteResult.exitCode === 0 ? remoteResult.text().trim() : undefined;

  const info = {
    toplevel,
    commonDir: resolve(toplevel, commonDir),
    normalizedRemote: rawRemote ? normalizeGitRemoteUrl(rawRemote) : undefined,
  };
  cache.set(key, info);
  return info;
}

export async function getGitRepoRoot(cwd?: string): Promise<string | undefined> {
  const info = await getGitRepoInfo(cwd);
  return info?.toplevel;
}

export async function getGitRepoIdentifier(cwd?: string): Promise<string | undefined> {
  const info = await getGitRepoInfo(cwd);
  return info?.commonDir;
}

export async function getGitNormalizedRemote(cwd?: string): Promise<string | undefined> {
  const info = await getGitRepoInfo(cwd);
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
