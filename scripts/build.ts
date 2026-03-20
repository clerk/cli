import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { targets } from "./releaser/targets.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    version: { type: "string", default: "0.0.0-dev" },
  },
});

const targetFilter = values.target;
const version = values.version!;

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
  if (!target.verifyPattern.test(fileOutput)) {
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
