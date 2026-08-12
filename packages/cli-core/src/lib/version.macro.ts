import cliPackage from "../../../cli/package.json";

const DEV_TAG = "dev";

type VersionValues = {
  currentVersion: string;
  isDevBuild: boolean;
};

type GitResult = {
  exitCode: number;
  stdout: string;
};

function isDevVersion(version: string): boolean {
  const dash = version.indexOf("-");
  if (dash === -1) return false;
  const prerelease = version.slice(dash + 1);
  return prerelease === DEV_TAG || prerelease.startsWith(`${DEV_TAG}.`);
}

function git(args: string[]): GitResult | undefined {
  try {
    // Anchor the lookup on this source file rather than the user's current
    // directory. Bun executes this module from the real checkout while it
    // transpiles or bundles the CLI.
    const process = Bun.spawnSync(["git", "--no-optional-locks", "-C", import.meta.dir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: process.exitCode, stdout: process.stdout.toString().trim() };
  } catch {
    return undefined;
  }
}

function describeCheckout(): string | undefined {
  const head = git(["log", "-1", "--format=%cs %h"]);
  if (!head || head.exitCode !== 0) return undefined;

  const [date, sha] = head.stdout.split(" ");
  if (!date || !sha) return undefined;

  // Semver forbids leading zeroes in an all-numeric prerelease identifier. The
  // `g` prefix is the same escape used by git-describe.
  const commit = /^0\d*$/.test(sha) ? `g${sha}` : sha;

  // Include untracked files because a build can consume source that the commit
  // does not describe.
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = status?.exitCode === 0 && status.stdout !== "" ? ".dirty" : "";

  return `${date.replaceAll("-", "")}.${commit}${dirty}`;
}

/**
 * Resolve the current version and dev-build status during Bun transpilation.
 *
 * Bun inlines the returned values at the macro call, so compiled binaries do
 * not execute Git commands or classify versions at runtime.
 */
export function resolveVersionAtBuildTime(): VersionValues {
  let currentVersion: string;
  if (typeof CLI_VERSION === "undefined") {
    const checkout = describeCheckout();
    currentVersion = `${cliPackage.version}-${DEV_TAG}${checkout ? `.${checkout}` : ""}`;
  } else {
    currentVersion = CLI_VERSION;
  }

  return {
    currentVersion,
    isDevBuild: isDevVersion(currentVersion),
  };
}
