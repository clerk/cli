import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { isPublished } from "./lib/npm.ts";

const WRAPPER_PKG_PATH = join(import.meta.dir, "../packages/cli/package.json");
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

const pkg = await Bun.file(WRAPPER_PKG_PATH).json();
const version: string = pkg.version;
const published = isPublished("clerk", version);

if (published) {
  console.log(`Version ${version} is already published — skipping stable release.`);
} else {
  console.log(`Version ${version} is not published — triggering stable release.`);
}

if (GITHUB_OUTPUT) {
  const lines = [`release_created=${!published}`];
  if (!published) lines.push(`version=${version}`);
  await appendFile(GITHUB_OUTPUT, lines.join("\n") + "\n");
}
