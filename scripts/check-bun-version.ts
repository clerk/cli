/**
 * Verify the running Bun satisfies the workspace's `engines.bun` range
 * before the test suite starts.
 *
 * The test scripts rely on `bun test --parallel` (which implies `--isolate`)
 * to run each test file in its own worker process. The flag only exists in
 * Bun >= 1.3.13; older versions silently ignore it, run every test file in
 * one process, and let `mock.module()` registrations bleed across files,
 * producing hundreds of order-dependent failures. Bun does not enforce
 * `engines.bun` at install time, so this preflight fails loudly instead.
 *
 * Usage:
 *   bun run scripts/check-bun-version.ts
 */

import { join } from "node:path";
import semver from "semver";

export interface CheckBunVersionResult {
  ok: boolean;
  message?: string;
}

export function checkBunVersion(current: string, range: string): CheckBunVersionResult {
  // includePrerelease so canary builds of a satisfying version pass.
  if (semver.satisfies(current, range, { includePrerelease: true })) {
    return { ok: true };
  }
  return {
    ok: false,
    message: [
      `error: this workspace requires Bun ${range}, but found ${current}.`,
      "",
      "The test scripts pass --parallel to `bun test` for per-file isolation.",
      "Older Bun versions silently ignore the flag, causing mock.module()",
      "registrations to leak across test files and fail unrelated tests.",
      "",
      "Upgrade with: bun upgrade",
    ].join("\n"),
  };
}

if (import.meta.main) {
  const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
  const range: string | undefined = pkg.engines?.bun;
  if (!range) {
    console.error("error: no `engines.bun` range found in the root package.json.");
    process.exit(1);
  }
  const result = checkBunVersion(Bun.version, range);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}
