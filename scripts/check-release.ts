import { join } from "node:path";
import { appendFile } from "node:fs/promises";

const WRAPPER_PKG_PATH = join(import.meta.dir, "../packages/cli/package.json");
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

const pkg = await Bun.file(WRAPPER_PKG_PATH).json();
const version: string = pkg.version;

// Check if this version is already published on npm
const result = Bun.spawnSync(["npm", "view", `clerk@${version}`, "version"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let isPublished: boolean;
if (result.exitCode === 0) {
  isPublished = result.stdout.toString().trim() === version;
} else {
  // Distinguish "not found" (E404) from real errors (network, auth)
  const stderr = result.stderr.toString();
  if (stderr.includes("E404") || stderr.includes("is not in this registry")) {
    isPublished = false;
  } else {
    throw new Error(`npm view clerk@${version} failed (exit ${result.exitCode}): ${stderr.trim()}`);
  }
}

if (!isPublished) {
  console.log(`Version ${version} is not published — triggering stable release.`);
  if (GITHUB_OUTPUT) {
    await appendFile(GITHUB_OUTPUT, `release_created=true\nversion=${version}\n`);
  }
} else {
  console.log(`Version ${version} is already published — skipping stable release.`);
  if (GITHUB_OUTPUT) {
    await appendFile(GITHUB_OUTPUT, `release_created=false\n`);
  }
}
