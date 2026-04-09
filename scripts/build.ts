import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { targets } from "./lib/targets.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    version: { type: "string", default: "0.0.0-dev" },
    "env-profiles-path": { type: "string" },
  },
});

const targetFilter = values.target;
const version = values.version!;

let envProfilesJson: string | undefined;
const envProfilesRaw = process.env.ENV_PROFILES;
const envProfilesPath = values["env-profiles-path"];

if (envProfilesRaw) {
  try {
    envProfilesJson = JSON.stringify(JSON.parse(envProfilesRaw));
  } catch (error) {
    throw new Error(`Error parsing ENV_PROFILES: ${error}`);
  }
  console.log(`Loaded environment profiles from ENV_PROFILES`);
} else if (envProfilesPath) {
  const file = Bun.file(envProfilesPath);
  if (!(await file.exists())) {
    throw new Error(`Environment profiles file not found: ${envProfilesPath}`);
  }
  // Parse to validate, then re-stringify compactly for --define injection
  const parsed = await file.json();
  envProfilesJson = JSON.stringify(parsed);
  console.log(`Loaded environment profiles from ${envProfilesPath}`);
}

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
  const buildArgs = [
    "bun",
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    `--target=${target.bunTarget}`,
    `--define`,
    `CLI_VERSION="${version}"`,
  ];

  if (envProfilesJson) {
    buildArgs.push("--define", `CLI_ENV_PROFILES=${envProfilesJson}`);
  }

  buildArgs.push("./packages/cli-core/src/cli.ts", "--outfile", outFile);

  const buildResult = Bun.spawnSync(buildArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (buildResult.exitCode !== 0) {
    console.error(`  FAIL: ${buildResult.stderr.toString().trim()}`);
    failed = true;
    continue;
  }

  // Verify binary format
  const fileResult = Bun.spawnSync(["file", outFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
