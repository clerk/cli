import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { targets } from "./releaser/targets.ts";

const VERIFY_PATTERNS: Record<string, RegExp> = {
  "darwin-arm64": /Mach-O.*arm64/,
  "darwin-x64": /Mach-O.*x86_64/,
  "linux-arm64": /ELF.*ARM aarch64/,
  "linux-arm64-musl": /ELF.*ARM aarch64/,
  "linux-x64": /ELF.*x86-64/,
  "linux-x64-musl": /ELF.*x86-64/,
  "win32-arm64": /PE32\+.*Aarch64/,
  "win32-x64": /PE32\+.*x86-64/,
};

function getArg(args: string[], name: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(): { targetFilter?: string; version: string } {
  const args = process.argv.slice(2);
  const targetFilter = getArg(args, "--target");
  const version = getArg(args, "--version") ?? "0.0.0-dev";
  return { targetFilter, version };
}

const { targetFilter, version } = parseArgs();

const selectedTargets = targetFilter
  ? targets.filter((t) => t.bunTarget === targetFilter || t.name === targetFilter)
  : targets;

if (selectedTargets.length === 0) {
  throw new Error(
    `Unknown target: ${targetFilter}\nAvailable targets: ${targets.map((t) => t.bunTarget).join(", ")}`,
  );
}

console.log(`Building ${selectedTargets.length} target(s) with version ${version}\n`);

let failed = false;
for (const target of selectedTargets) {
  const outDir = join("dist", "artifacts", target.name);
  const outFile = join(outDir, `clerk${target.ext}`);

  await mkdir(outDir, { recursive: true });

  console.log(`Building ${target.name} (${target.bunTarget})...`);
  const buildResult = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      `--target=${target.bunTarget}`,
      `--define`,
      `CLI_VERSION="${version}"`,
      "./packages/cli-core/src/cli.ts",
      "--outfile",
      outFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  if (buildResult.exitCode !== 0) {
    console.error(`  FAIL: ${buildResult.stderr.toString().trim()}`);
    failed = true;
    continue;
  }

  // Verify binary format
  const fileResult = Bun.spawnSync(["file", outFile], { stdio: ["ignore", "pipe", "pipe"] });
  const fileOutput = fileResult.stdout.toString();
  const pattern = VERIFY_PATTERNS[target.name];
  if (!pattern || !pattern.test(fileOutput)) {
    console.error(`  FAIL: binary format mismatch for ${target.name}`);
    console.error(`  file output: ${fileOutput.trim()}`);
    failed = true;
    continue;
  }

  console.log(`  OK: ${outFile}`);
}

if (failed) {
  throw new Error("Some targets failed to build.");
}

console.log("\nAll targets built successfully.");
