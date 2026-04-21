import { mkdir, cp, rm, chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Target, targets, SCOPE, PKG_PREFIX } from "./lib/targets.ts";
import { run, isPublished, publish } from "./lib/npm.ts";
import { getStableReleaseCreateArgs } from "./lib/release-notes.ts";

const DIST_DIR = join(import.meta.dir, "../dist/platform-packages");
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(import.meta.dir, "../dist/artifacts");
const WRAPPER_PKG_PATH = join(import.meta.dir, "../packages/cli/package.json");

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

  const licensePath = join(import.meta.dir, "../LICENSE");
  await copyFile(licensePath, join(dir, "LICENSE"));

  return dir;
}

const { dryRun, tag, versionOverride } = parseCliArgs();
const version = versionOverride ?? (await Bun.file(WRAPPER_PKG_PATH).json()).version;
console.log(
  `Publishing version ${version}${tag ? ` (tag: ${tag})` : ""}${dryRun ? " (dry run)" : ""}`,
);

await rm(DIST_DIR, { recursive: true, force: true });

await Promise.all(
  targets.map(async (target) => {
    const name = packageName(target.name);
    if (await isPublished(name, version)) {
      console.log(`Skipping ${name}@${version} (already published)`);
      return;
    }
    console.log(`Publishing ${name}@${version}...`);
    const dir = await generatePlatformPackage(target, version);
    await publish(dir, { dryRun, tag });
  }),
);

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
  if (await isPublished(wrapperName, version)) {
    console.log(`Skipping ${wrapperName}@${version} (already published)`);
  } else {
    console.log(`Publishing ${wrapperName}@${version}...`);
    await publish(join(import.meta.dir, "../packages/cli"), { dryRun, tag });
  }
} finally {
  await Bun.write(WRAPPER_PKG_PATH, wrapperRaw);
}

// Create git tag and GitHub Release for stable releases (no --tag flag).
// Canary (--tag canary) and snapshot (--tag snapshot) skip this.
if (!tag && !dryRun) {
  const tagName = `v${version}`;

  const remoteTagCheck = Bun.spawnSync(
    ["git", "ls-remote", "--tags", "origin", `refs/tags/${tagName}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const remoteTagExists =
    remoteTagCheck.exitCode === 0 && remoteTagCheck.stdout.toString().trim().length > 0;

  if (remoteTagExists) {
    console.log(`Tag ${tagName} already exists on remote, skipping tag push.`);
  } else {
    console.log(`Creating and pushing tag ${tagName}...`);
    const localTagCheck = Bun.spawnSync(["git", "rev-parse", tagName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (localTagCheck.exitCode !== 0) {
      await run(["git", "tag", tagName]);
    }
    await run(["git", "push", "origin", tagName]);
  }

  const releaseViewCheck = Bun.spawnSync(["gh", "release", "view", tagName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (releaseViewCheck.exitCode === 0) {
    console.log(`GitHub Release for ${tagName} already exists, skipping.`);
  } else {
    console.log(`Creating GitHub Release for ${tagName}...`);
    const { args: releaseArgs, notesPath } = await getStableReleaseCreateArgs(version);
    if (notesPath) {
      console.log(`Prepending release intro from ${notesPath}...`);
    }
    await run(releaseArgs);
  }
}

console.log("Done!");
