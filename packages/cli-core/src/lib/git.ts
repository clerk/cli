import { join, resolve } from "node:path";
import { log } from "./log.ts";

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

  let result;
  try {
    result = await $`git rev-parse --show-toplevel --git-common-dir`.cwd(key).quiet().nothrow();
  } catch {
    // Directory doesn't exist or other error (e.g., ENOENT)
    log.debug(`git: rev-parse threw (cwd=${key})`);
    cache.set(key, undefined);
    return undefined;
  }

  if (result.exitCode !== 0) {
    log.debug("git: not a git repository (git rev-parse failed)");
    cache.set(key, undefined);
    return undefined;
  }

  const lines = result.text().trim().split("\n");
  const toplevel = lines[0];
  const commonDir = lines[1];
  if (!toplevel || !commonDir) {
    log.debug("git: rev-parse returned no toplevel/commonDir");
    cache.set(key, undefined);
    return undefined;
  }

  // Fetch remote URL (non-blocking since rev-parse already succeeded)
  let rawRemote: string | undefined;
  try {
    const remoteResult = await $`git remote get-url origin`.cwd(key).quiet().nothrow();
    rawRemote = remoteResult.exitCode === 0 ? remoteResult.text().trim() : undefined;
  } catch {
    // Directory error or git command failed
    rawRemote = undefined;
  }

  const info = {
    toplevel,
    commonDir: resolve(toplevel, commonDir),
    normalizedRemote: rawRemote ? normalizeGitRemoteUrl(rawRemote) : undefined,
  };
  cache.set(key, info);
  log.debug(
    `git: toplevel=${info.toplevel}, commonDir=${info.commonDir}, remote=${info.normalizedRemote ?? "<none>"}`,
  );
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

/**
 * Adds `entry` to the project's `.gitignore` unless it is already listed.
 *
 * The CLI writes files into a user's repository that must not be committed —
 * the keyless breadcrumb, and the migration settings file. Creating one without
 * this is how a live credential ends up in a tracked file.
 */
export async function ensureGitignoreEntry(cwd: string, entry: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const content = await Bun.file(gitignorePath)
    .text()
    .catch(() => "");
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return;
  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await Bun.write(gitignorePath, `${content}${separator}${entry}\n`);
  log.debug(`git: added ${entry} to .gitignore`);
}
