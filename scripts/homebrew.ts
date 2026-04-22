import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import {
  renderFormula,
  createArchive,
  computeChecksum,
  parseMajorVersion,
  HOMEBREW_TARGETS,
  type FormulaInput,
} from "./lib/homebrew.ts";
import { run } from "./lib/npm.ts";

const DEFAULT_ARTIFACTS_DIR =
  process.env.ARTIFACTS_DIR ?? join(import.meta.dir, "../dist/artifacts");

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "artifacts-dir": { type: "string" },
    "tap-repo": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.version) {
  console.error("--version is required.");
  process.exit(1);
}

const version = values.version;
const artifactsDir = values["artifacts-dir"] ?? DEFAULT_ARTIFACTS_DIR;
const tapRepo = values["tap-repo"] ?? "clerk/homebrew-stable";
const dryRun = values["dry-run"]!;

if (!dryRun && !process.env.HOMEBREW_TAP_TOKEN) {
  console.error("HOMEBREW_TAP_TOKEN is required (use --dry-run to skip).");
  process.exit(1);
}

console.log(`Homebrew distribution: v${version}${dryRun ? " (dry run)" : ""}`);
console.log(`Artifacts dir: ${artifactsDir}`);
console.log(`Tap repo: ${tapRepo}`);

const workDir = await mkdtemp(join(tmpdir(), "homebrew-archives-"));
console.log(`Work directory: ${workDir}`);

const archivePaths = new Map<string, string>();

for (const target of HOMEBREW_TARGETS) {
  const binaryPath = join(artifactsDir, `clerk-${target.name}`, "clerk");
  const archivePath = join(workDir, `homebrew-clerk-${target.name}.tar.gz`);
  console.log(`Creating archive for ${target.name}...`);
  createArchive(binaryPath, archivePath);
  archivePaths.set(target.name, archivePath);
}

const tagName = `v${version}`;
for (const target of HOMEBREW_TARGETS) {
  const archivePath = archivePaths.get(target.name)!;
  if (dryRun) {
    console.log(`[dry-run] Would upload ${basename(archivePath)} to ${tagName}`);
  } else {
    console.log(`Uploading ${basename(archivePath)} to ${tagName}...`);
    await run(["gh", "release", "upload", tagName, archivePath, "--clobber"]);
  }
}

console.log("Computing checksums...");
const checksums = {} as FormulaInput["checksums"];
for (const target of HOMEBREW_TARGETS) {
  const archivePath = archivePaths.get(target.name)!;
  checksums[target.name] = await computeChecksum(archivePath);
}

for (const target of HOMEBREW_TARGETS) {
  console.log(`  ${target.name}: ${checksums[target.name]}`);
}

const formula = renderFormula({ version, checksums });
console.log("\nRendered formula:");
console.log(formula);

const major = parseMajorVersion(version);
const versionedFormula = renderFormula({ version, checksums, major });
console.log("\nRendered versioned formula:");
console.log(versionedFormula);

if (dryRun) {
  console.log("[dry-run] Skipping tap clone and push.");
  console.log(`[dry-run] Would write Formula/clerk.rb and Formula/clerk@${major}.rb`);
} else {
  const token = process.env.HOMEBREW_TAP_TOKEN!;

  const tapWorkDir = join(workDir, "tap-workdir");
  console.log(`Cloning tap repo ${tapRepo}...`);
  await run(["git", "clone", `https://github.com/${tapRepo}.git`, tapWorkDir]);
  const setUrlResult = Bun.spawnSync(
    [
      "git",
      "remote",
      "set-url",
      "origin",
      `https://x-access-token:${token}@github.com/${tapRepo}.git`,
    ],
    { cwd: tapWorkDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (setUrlResult.exitCode !== 0) {
    throw new Error("Failed to configure authenticated remote for tap repo");
  }

  const formulaDir = join(tapWorkDir, "Formula");
  await mkdir(formulaDir, { recursive: true });
  const formulaPath = join(formulaDir, "clerk.rb");
  await writeFile(formulaPath, formula, "utf-8");
  console.log(`Wrote formula to ${formulaPath}`);

  const versionedFormulaPath = join(formulaDir, `clerk@${major}.rb`);
  await writeFile(versionedFormulaPath, versionedFormula, "utf-8");
  console.log(`Wrote versioned formula to ${versionedFormulaPath}`);

  await run(["git", "config", "user.name", "clerk-bot"], { cwd: tapWorkDir });
  await run(["git", "config", "user.email", "bot@clerk.com"], { cwd: tapWorkDir });
  await run(["git", "add", "Formula/clerk.rb", `Formula/clerk@${major}.rb`], { cwd: tapWorkDir });

  const diffResult = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
    cwd: tapWorkDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (diffResult.exitCode === 0) {
    console.log("No changes to formula, skipping commit and push.");
  } else {
    console.log(`Committing and pushing formula for clerk ${version}...`);
    await run(["git", "commit", "-m", `clerk ${version}`], { cwd: tapWorkDir });
    await run(["git", "push", "origin", "main"], { cwd: tapWorkDir });
    console.log("Pushed formula to tap.");
  }
}

console.log("Done!");
