import { join } from "node:path";

const CHANGESET_CONFIG = join(import.meta.dir, "../.changeset/config.json");
const WRAPPER_PKG = join(import.meta.dir, "../packages/cli/package.json");

// Step 1: Temporarily disable changelog generation
const configRaw = await Bun.file(CHANGESET_CONFIG).text();
const config = JSON.parse(configRaw);
config.changelog = false;
await Bun.write(CHANGESET_CONFIG, JSON.stringify(config, null, 2) + "\n");

try {
  // Step 2: Exit prerelease mode if active
  Bun.spawnSync(["bunx", "changeset", "pre", "exit"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Step 3: Bump versions to clear any pre state
  Bun.spawnSync(["bunx", "changeset", "version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Step 4: Create temp changeset forcing a patch bump on clerk
  const snapshot = `---\n"clerk": patch\n---\n\nCanary release\n`;
  await Bun.write(join(import.meta.dir, "../.changeset/canary-temp.md"), snapshot);

  // Step 5: Run changeset version --snapshot canary
  const result = Bun.spawnSync(["bunx", "changeset", "version", "--snapshot", "canary"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode !== 0) {
    console.error(`changeset version failed: ${result.stderr.toString().trim()}`);
    console.log("success=0");
  } else {
    const pkg = await Bun.file(WRAPPER_PKG).json();
    console.log(`Canary version: ${pkg.version}`);
    console.log("success=1");
  }
} finally {
  // Step 6: Restore original config from git
  Bun.spawnSync(["git", "checkout", "HEAD", "--", CHANGESET_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
