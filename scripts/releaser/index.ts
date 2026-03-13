import { mkdir, cp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { type Target, targets, SCOPE, PKG_PREFIX } from "./targets.ts";

const DIST_DIR = join(import.meta.dir, "../../dist/platform-packages");
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(import.meta.dir, "../../dist/artifacts");
const WRAPPER_PKG_PATH = join(import.meta.dir, "../../packages/cli/package.json");

function parseArgs(): { dryRun: boolean; tag?: string; versionOverride?: string } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const tagIdx = args.indexOf("--tag");
  const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;

  const versionIdx = args.indexOf("--version");
  const versionOverride = versionIdx !== -1 ? args[versionIdx + 1] : undefined;

  return { dryRun, tag, versionOverride };
}

async function readVersion(): Promise<string> {
  const pkg = await Bun.file(WRAPPER_PKG_PATH).json();
  return pkg.version;
}

function packageName(targetName: string): string {
  return `${SCOPE}/${PKG_PREFIX}-${targetName}`;
}

function isPublished(name: string, version: string): boolean {
  const result = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.exitCode === 0) return true;

  // "npm view" exits non-zero for both "not found" and real errors (network, auth).
  // Treat only E404 / "not found" as unpublished; propagate everything else.
  const stderr = result.stderr.toString();
  if (stderr.includes("E404") || stderr.includes("is not in this registry")) {
    return false;
  }

  throw new Error(`npm view ${name}@${version} failed (exit ${result.exitCode}): ${stderr.trim()}`);
}

async function generatePlatformPackage(target: Target, version: string): Promise<string> {
  const dir = join(DIST_DIR, target.name);
  const binDir = join(dir, "bin");

  await mkdir(binDir, { recursive: true });

  const ext = target.os === "win32" ? ".exe" : "";
  const binaryName = `clerk${ext}`;
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
  };
  if (target.libc) {
    pkg.libc = [target.libc];
  }
  await Bun.write(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  return dir;
}

function publish(dir: string, dryRun: boolean, tag?: string): void {
  const flags = ["npm", "publish", "--access", "public", "--ignore-scripts"];
  if (tag) flags.push("--tag", tag);
  if (dryRun) flags.push("--dry-run");
  const result = Bun.spawnSync(flags, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`npm publish failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`);
  }
}

const { dryRun, tag, versionOverride } = parseArgs();
const version = versionOverride ?? (await readVersion());
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

  const wrapperName = `${SCOPE}/${PKG_PREFIX}`;
  if (isPublished(wrapperName, version)) {
    console.log(`Skipping ${wrapperName}@${version} (already published)`);
  } else {
    console.log(`Publishing ${wrapperName}@${version}...`);
    publish(join(import.meta.dir, "../../packages/cli"), dryRun, tag);
  }
} finally {
  await Bun.write(WRAPPER_PKG_PATH, wrapperRaw);
}

console.log("Done!");
