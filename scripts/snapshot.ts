import { join } from "node:path";

const CHANGESET_CONFIG = join(import.meta.dir, "../.changeset/config.json");
const WRAPPER_PKG = join(import.meta.dir, "../packages/cli/package.json");

// Parse --name flag
function parseName(): string {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf("--name");
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    return args[nameIdx + 1];
  }
  // Also accept positional: bun run scripts/snapshot.ts my-feature
  const positional = args.find((a) => !a.startsWith("-"));
  return positional || "snapshot";
}

const name = parseName();

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
    console.error(`changeset version failed: ${result.stderr.toString().trim()}`);
    console.log("success=0");
  } else {
    const pkg = await Bun.file(WRAPPER_PKG).json();
    console.log(`Snapshot version: ${pkg.version}`);
    console.log("success=1");
  }
} finally {
  // Restore config
  Bun.spawnSync(["git", "checkout", "HEAD", "--", CHANGESET_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
