import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEV_CLI_VERSION } from "../packages/cli-core/src/lib/version.ts";
import { type Target, targets } from "./lib/targets.ts";

function keyringBindingPath(target: Target): string {
  const libcSuffix = target.libc === "musl" ? "-musl" : target.libc === "glibc" ? "-gnu" : "";
  const winSuffix = target.os === "win32" ? "-msvc" : "";
  const bindingName = `${target.os}-${target.cpu}${libcSuffix}${winSuffix}`;
  return join("node_modules", "@napi-rs", `keyring-${bindingName}`, `keyring.${bindingName}.node`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    version: { type: "string", default: DEV_CLI_VERSION },
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

// Cross-compile embeds each target's @napi-rs/keyring native binding into
// the output. A default `bun install` on any single host skips the bindings
// for other platforms (optional deps are filtered by os/cpu), so without a
// platform-unfiltered install the darwin/win32/arm64 builds would silently
// ship without the binding and fall back to plaintext-file credentials at
// runtime. Fail fast here so the dev sees the actionable fix.
const bindingChecks = await Promise.all(
  selectedTargets.map(async (t) => {
    const path = keyringBindingPath(t);
    return { target: t, path, exists: await Bun.file(path).exists() };
  }),
);
const missingBindings = bindingChecks.filter((check) => !check.exists);
if (missingBindings.length > 0) {
  const list = missingBindings.map(({ target, path }) => `  - ${target.name}: ${path}`).join("\n");
  throw new Error(
    `Missing @napi-rs/keyring native bindings for:\n${list}\n\n` +
      `Run \`bun install --frozen-lockfile --cpu='*' --os='*'\` to install every platform's optional deps.`,
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
