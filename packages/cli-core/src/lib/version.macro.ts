import cliPackage from "../../../cli/package.json";

const DEV_TAG = "dev";

type GitResult = {
  exitCode: number;
  stdout: string;
};

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
 * Derive the checkout-based dev version during Bun transpilation.
 *
 * Bun inlines the returned string at the macro call, so compiled binaries do
 * not execute Git commands at runtime.
 *
 * The macro deliberately does not read the `CLI_VERSION` define: Bun 1.4.0
 * stopped substituting `--define` globals inside macro execution, so the
 * injected-version check lives at the call site in `version.ts`, where module
 * code still folds the define reliably. The value returned here is always a
 * `-dev` prerelease.
 */
export function resolveDevVersionAtBuildTime(): string {
  const checkout = describeCheckout();
  return `${cliPackage.version}-${DEV_TAG}${checkout ? `.${checkout}` : ""}`;
}
