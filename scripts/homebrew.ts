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

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(import.meta.dir, "../dist/artifacts");

function parseCliArgs(): {
  version: string;
  artifactsDir: string;
  tapRepo: string;
  dryRun: boolean;
} {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      version: { type: "string" },
      "artifacts-dir": { type: "string" },
      "tap-repo": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.version) {
    throw new Error("--version is required");
  }

  return {
    version: values.version,
    artifactsDir: values["artifacts-dir"] ?? ARTIFACTS_DIR,
    tapRepo: values["tap-repo"] ?? "clerk/homebrew-stable",
    dryRun: values["dry-run"]!,
  };
}

const { version, artifactsDir, tapRepo, dryRun } = parseCliArgs();

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
    run(["gh", "release", "upload", tagName, archivePath, "--clobber"]);
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
  const token = process.env.HOMEBREW_TAP_TOKEN;
  if (!token) {
    throw new Error("HOMEBREW_TAP_TOKEN env var is required for pushing to tap");
  }

  const tapWorkDir = join(workDir, "tap-workdir");
  console.log(`Cloning tap repo ${tapRepo}...`);
  run(["git", "clone", `https://github.com/${tapRepo}.git`, tapWorkDir]);
  run(
    [
      "git",
      "remote",
      "set-url",
      "origin",
      `https://x-access-token:${token}@github.com/${tapRepo}.git`,
    ],
    { cwd: tapWorkDir },
  );

  const formulaDir = join(tapWorkDir, "Formula");
  await mkdir(formulaDir, { recursive: true });
  const formulaPath = join(formulaDir, "clerk.rb");
  await writeFile(formulaPath, formula, "utf-8");
  console.log(`Wrote formula to ${formulaPath}`);

  const versionedFormulaPath = join(formulaDir, `clerk@${major}.rb`);
  await writeFile(versionedFormulaPath, versionedFormula, "utf-8");
  console.log(`Wrote versioned formula to ${versionedFormulaPath}`);

  run(["git", "config", "user.name", "clerk-bot"], { cwd: tapWorkDir });
  run(["git", "config", "user.email", "bot@clerk.com"], { cwd: tapWorkDir });
  run(["git", "add", "Formula/clerk.rb", `Formula/clerk@${major}.rb`], { cwd: tapWorkDir });

  const diffResult = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
    cwd: tapWorkDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (diffResult.exitCode === 0) {
    console.log("No changes to formula, skipping commit and push.");
  } else {
    console.log(`Committing and pushing formula for clerk ${version}...`);
    run(["git", "commit", "-m", `clerk ${version}`], { cwd: tapWorkDir });
    run(["git", "push", "origin", "main"], { cwd: tapWorkDir });
    console.log("Pushed formula to tap.");
  }
}

console.log("Done!");
