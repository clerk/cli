/**
 * Run a command asynchronously, throwing on non-zero exit.
 */
export async function run(cmd: string[], opts?: { cwd?: string }): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `${cmd.join(" ")} failed (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
}

/**
 * Check if a package version is published on npm.
 * Distinguishes "not found" (E404) from real errors (network, auth).
 */
export async function isPublished(name: string, version: string): Promise<boolean> {
  const proc = Bun.spawn(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) return true;
  const stderr = await new Response(proc.stderr).text();
  if (stderr.includes("E404") || stderr.includes("is not in this registry")) {
    return false;
  }
  throw new Error(`npm view ${name}@${version} failed (exit ${exitCode}): ${stderr.trim()}`);
}

/**
 * Publish a package directory to npm.
 */
export async function publish(dir: string, opts: { dryRun: boolean; tag?: string }): Promise<void> {
  const flags = ["npm", "publish", "--access", "public", "--provenance", "--ignore-scripts"];
  if (opts.tag) flags.push("--tag", opts.tag);
  if (opts.dryRun) flags.push("--dry-run");
  await run(flags, { cwd: dir });
}
