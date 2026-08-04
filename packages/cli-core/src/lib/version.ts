/**
 * Release binaries are compiled with `--define CLI_VERSION="x.y.z"`, so the
 * global holds the published version. Everything else — `bun run dev`, a
 * `bun link`ed checkout on your PATH, a local `build:compile` — has no define
 * and reports a *dev* version derived from the checkout it runs from:
 *
 *   3.0.0-dev.20260803.f51f1e4          clean tree at commit f51f1e4
 *   3.0.0-dev.20260803.f51f1e4.dirty    ...with uncommitted changes
 *   3.0.0-dev                           git unavailable, or not run from a checkout
 *
 * The base is the version `packages/cli` currently publishes at, so you can see
 * which release your checkout sits on. The commit segment is the part that
 * moves when you pull, which is what makes `clerk --version` able to answer
 * "is the `clerk` on my PATH the code I just fetched?".
 *
 * Two callers care about the dev/release *distinction* rather than the string:
 * `credential-store` namespaces the macOS keychain away from release builds,
 * and `update-check` suppresses update prompts. Both go through
 * `resolveCliVersion` / `isDevVersion` rather than matching a fixed constant,
 * since a dev version is no longer a single literal.
 */

import cliPackage from "../../../cli/package.json";

const DEV_TAG = "dev";

/**
 * True for any version whose prerelease starts with `dev` — the shape every
 * unversioned build reports. Real prereleases (`-canary.*`, `-snapshot.*`) and
 * stable versions are not dev.
 */
export function isDevVersion(version: string): boolean {
  const dash = version.indexOf("-");
  if (dash === -1) return false;
  const prerelease = version.slice(dash + 1);
  return prerelease === DEV_TAG || prerelease.startsWith(`${DEV_TAG}.`);
}

/**
 * Resolve the current CLI version, or `undefined` when running an unversioned
 * dev build. Anything that wants to *display* a version should fall back to
 * `resolveDevVersion()`; anything that wants to *decide* whether this binary is
 * meaningfully versioned should check for `undefined` here.
 */
export function resolveCliVersion(): string | undefined {
  if (typeof CLI_VERSION === "undefined") return undefined;
  if (isDevVersion(CLI_VERSION)) return undefined;
  return CLI_VERSION;
}

function git(args: string[]): { exitCode: number; stdout: string } | undefined {
  try {
    // `-C import.meta.dir` anchors on the checkout this code was loaded from,
    // not the user's cwd — the CLI is normally run from some other project.
    // `--no-optional-locks` keeps a version lookup from fighting a concurrent
    // git command for the index lock.
    const proc = Bun.spawnSync(["git", "--no-optional-locks", "-C", import.meta.dir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString().trim() };
  } catch {
    // git missing from PATH, or import.meta.dir isn't a real directory (it
    // points inside the virtual filesystem of a compiled binary).
    return undefined;
  }
}

function describeCheckout(): string | undefined {
  const head = git(["log", "-1", "--format=%cs %h"]);
  if (!head || head.exitCode !== 0) return undefined;

  const [date, sha] = head.stdout.split(" ");
  if (!date || !sha) return undefined;

  // Semver forbids leading zeroes in an all-numeric prerelease identifier, and
  // an abbreviated sha can come out all digits. `g` is git-describe's own
  // escape for the same problem.
  const commit = /^0\d*$/.test(sha) ? `g${sha}` : sha;

  const diff = git(["diff", "--quiet", "HEAD"]);
  const dirty = diff?.exitCode === 1 ? ".dirty" : "";

  return `${date.replaceAll("-", "")}.${commit}${dirty}`;
}

let devVersion: string | undefined;

/**
 * The version string an unversioned build reports. Memoized: it shells out to
 * git, and `--version`, the outbound user agent, and MCP client info all ask
 * for it.
 */
export function resolveDevVersion(): string {
  if (devVersion) return devVersion;
  const checkout = describeCheckout();
  devVersion = `${cliPackage.version}-${DEV_TAG}${checkout ? `.${checkout}` : ""}`;
  return devVersion;
}
