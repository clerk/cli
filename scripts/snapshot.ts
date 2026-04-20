import { join } from "node:path";
import { parseArgs } from "node:util";
import { isPublished } from "./lib/npm.ts";

const CHANGESET_CONFIG = join(import.meta.dir, "../.changeset/config.json");
const WRAPPER_PKG = join(import.meta.dir, "../packages/cli/package.json");

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    name: { type: "string" },
  },
  allowPositionals: true,
});

const name = values.name || positionals[0] || "snapshot";

// Validate kebab-case
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  throw new Error(`Invalid snapshot name: ${name} (must be kebab-case)`);
}

// Temporarily disable changelog generation
const configRaw = await Bun.file(CHANGESET_CONFIG).text();
const config = JSON.parse(configRaw);
config.changelog = false;
await Bun.write(CHANGESET_CONFIG, JSON.stringify(config, null, 2) + "\n");

try {
  // Exit prerelease mode if active
  Bun.spawnSync(["bunx", "changeset", "pre", "exit"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Bump versions to clear pre state
  Bun.spawnSync(["bunx", "changeset", "version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Create temp changeset
  const snapshot = `---\n"clerk": patch\n---\n\nSnapshot release\n`;
  await Bun.write(join(import.meta.dir, "../.changeset/snapshot-temp.md"), snapshot);

  // Run changeset version --snapshot <name>
  const result = Bun.spawnSync(["bunx", "changeset", "version", "--snapshot", name], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode !== 0) {
    throw new Error(`changeset version failed: ${result.stderr.toString().trim()}`);
  }

  const pkg = await Bun.file(WRAPPER_PKG).json();

  // Changesets substitutes `{commit}` in `prereleaseTemplate` with the full
  // 40-char SHA from `git rev-parse HEAD`. Rewrite it to the short SHA so the
  // published version string stays readable (e.g. `0.8.6-snapshot.a1b2c3d`).
  const shortShaResult = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (shortShaResult.exitCode !== 0) {
    throw new Error(
      `git rev-parse --short HEAD failed: ${shortShaResult.stderr.toString().trim()}`,
    );
  }
  const shortSha = shortShaResult.stdout.toString().trim();
  const originalVersion: string = pkg.version;
  const finalVersion = originalVersion.replace(/[a-f0-9]{40}$/, shortSha);
  if (finalVersion !== originalVersion) {
    pkg.version = finalVersion;
    await Bun.write(WRAPPER_PKG, JSON.stringify(pkg, null, 2) + "\n");
  }

  // Bail early if this commit has already been snapshotted. The build, sign,
  // and test jobs would otherwise run for several minutes only for npm to
  // reject the final publish as a duplicate.
  if (await isPublished("clerk", finalVersion)) {
    throw new Error(
      `clerk@${finalVersion} is already published. Push a new commit or re-run with a different tag (e.g. \`!snapshot retry\`).`,
    );
  }

  console.log(`Snapshot version: ${finalVersion}`);
} finally {
  // Restore config
  Bun.spawnSync(["git", "checkout", "HEAD", "--", CHANGESET_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
