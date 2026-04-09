/**
 * Run a command synchronously, throwing on non-zero exit.
 */
export function run(cmd: string[], opts?: { cwd?: string }): void {
  const result = Bun.spawnSync(cmd, {
    cwd: opts?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `${cmd.join(" ")} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

/**
 * Check if a package version is published on npm.
 * Distinguishes "not found" (E404) from real errors (network, auth).
 */
export function isPublished(name: string, version: string): boolean {
  const result = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode === 0) return true;

  const stderr = result.stderr.toString();
  if (stderr.includes("E404") || stderr.includes("is not in this registry")) {
    return false;
  }

  throw new Error(`npm view ${name}@${version} failed (exit ${result.exitCode}): ${stderr.trim()}`);
}

/**
 * Publish a package directory to npm.
 */
export function publish(dir: string, opts: { dryRun: boolean; tag?: string }): void {
  // --provenance requires a public repository. Once this repo is made public and
  // NODE_AUTH_TOKEN is removed in favour of OIDC trusted publishing, re-enable it.
  const flags = ["npm", "publish", "--access", "public", "--ignore-scripts"];
  if (opts.tag) flags.push("--tag", opts.tag);
  if (opts.dryRun) flags.push("--dry-run");
  run(flags, { cwd: dir });
}
