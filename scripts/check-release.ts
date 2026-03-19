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

const isPublished = result.exitCode === 0 && result.stdout.toString().trim() === version;

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
