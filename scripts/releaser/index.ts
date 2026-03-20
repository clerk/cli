import { mkdir, cp, rm, chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Target, targets, SCOPE, PKG_PREFIX } from "./targets.ts";
import { isPublished } from "../lib/npm.ts";

const DIST_DIR = join(import.meta.dir, "../../dist/platform-packages");
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(import.meta.dir, "../../dist/artifacts");
const WRAPPER_PKG_PATH = join(import.meta.dir, "../../packages/cli/package.json");

function run(cmd: string[], opts?: { cwd?: string }): void {
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

function parseCliArgs(): { dryRun: boolean; tag?: string; versionOverride?: string } {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      tag: { type: "string" },
      version: { type: "string" },
    },
  });
  return { dryRun: values["dry-run"]!, tag: values.tag, versionOverride: values.version };
}

function packageName(targetName: string): string {
  return `${SCOPE}/${PKG_PREFIX}-${targetName}`;
}

async function generatePlatformPackage(target: Target, version: string): Promise<string> {
  const dir = join(DIST_DIR, target.name);
  const binDir = join(dir, "bin");

  await mkdir(binDir, { recursive: true });

  const binaryName = `clerk${target.ext}`;
  const artifactPath = join(ARTIFACTS_DIR, `clerk-${target.name}`, binaryName);
  const destPath = join(binDir, binaryName);
  await cp(artifactPath, destPath);
  await chmod(destPath, 0o755);

  const pkg: Record<string, unknown> = {
    name: packageName(target.name),
    version,
    description: `Clerk CLI binary for ${target.name}`,
    license: "MIT",
    repository: { type: "git", url: "https://github.com/clerk/cli.git" },
    homepage: "https://clerk.com/docs",
    os: [target.os],
    cpu: [target.cpu],
    preferUnplugged: true,
    files: ["bin"],
  };
  if (target.libc) {
    pkg.libc = [target.libc];
  }
  await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Include the LICENSE file in each platform package.
  const licensePath = join(import.meta.dir, "../../LICENSE");
  await copyFile(licensePath, join(dir, "LICENSE"));

  return dir;
}

function publish(dir: string, dryRun: boolean, tag?: string): void {
  const flags = ["npm", "publish", "--access", "public", "--provenance", "--ignore-scripts"];
  if (tag) flags.push("--tag", tag);
  if (dryRun) flags.push("--dry-run");
  run(flags, { cwd: dir });
}

const { dryRun, tag, versionOverride } = parseCliArgs();
const version = versionOverride ?? (await Bun.file(WRAPPER_PKG_PATH).json()).version;
console.log(
  `Publishing version ${version}${tag ? ` (tag: ${tag})` : ""}${dryRun ? " (dry run)" : ""}`,
);

await rm(DIST_DIR, { recursive: true, force: true });

for (const target of targets) {
  const name = packageName(target.name);
  if (isPublished(name, version)) {
    console.log(`Skipping ${name}@${version} (already published)`);
    continue;
  }
  console.log(`Publishing ${name}@${version}...`);
  const dir = await generatePlatformPackage(target, version);
  publish(dir, dryRun, tag);
}

// Build wrapper package.json for publishing: add optionalDependencies from targets and remove private flag.
// This mutation is intentional — the repo omits optionalDependencies while the published package includes them.
// We restore the original file after publishing (or on failure) so the working tree stays clean.
const wrapperRaw = await Bun.file(WRAPPER_PKG_PATH).text();
try {
  const wrapperPkg = JSON.parse(wrapperRaw);
  wrapperPkg.version = version;
  wrapperPkg.optionalDependencies = Object.fromEntries(
    targets.map((t) => [packageName(t.name), version]),
  );
  delete wrapperPkg.private;
  await Bun.write(WRAPPER_PKG_PATH, JSON.stringify(wrapperPkg, null, 2) + "\n");

  const wrapperName = "clerk";
  if (isPublished(wrapperName, version)) {
    console.log(`Skipping ${wrapperName}@${version} (already published)`);
  } else {
    console.log(`Publishing ${wrapperName}@${version}...`);
    publish(join(import.meta.dir, "../../packages/cli"), dryRun, tag);
  }
} finally {
  await Bun.write(WRAPPER_PKG_PATH, wrapperRaw);
}

// Create git tag and GitHub Release for stable releases (no --tag flag).
// Canary (--tag canary) and snapshot (--tag snapshot) skip this.
if (!tag && !dryRun) {
  const tagName = `v${version}`;

  // Check if tag already exists (idempotency)
  const tagCheck = Bun.spawnSync(["git", "rev-parse", tagName], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (tagCheck.exitCode === 0) {
    console.log(`Tag ${tagName} already exists, skipping.`);
  } else {
    console.log(`Creating tag ${tagName}...`);
    run(["git", "tag", tagName]);
    run(["git", "push", "origin", tagName]);

    console.log(`Creating GitHub Release for ${tagName}...`);
    run(["gh", "release", "create", tagName, "--generate-notes"]);
  }
}

console.log("Done!");
