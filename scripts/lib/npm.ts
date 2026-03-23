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
