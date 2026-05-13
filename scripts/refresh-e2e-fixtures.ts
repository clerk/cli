#!/usr/bin/env bun
/**
 * Regenerates e2e fixture directories from real framework CLI tools.
 *
 * Usage:
 *   bun run scripts/refresh-e2e-fixtures.ts           # refresh fixtures without pinned ranges
 *   bun run scripts/refresh-e2e-fixtures.ts --only nextjs-app-router
 */

import { rm, cp, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { Glob } from "bun";
import semver from "semver";
import {
  applyPackageJsonOverrides,
  assertPinnedDependencyRanges,
  resolveDependencySpecsToExactVersions,
} from "./lib/fixture-deps.ts";

// Set env var to signal that we're importing fixtures for config reading only,
// not for test registration. This must be set BEFORE importing any fixture files.
process.env.CLERK_REFRESH_FIXTURES = "1";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    only: { type: "string" },
  },
  strict: true,
});
const onlyName = values.only ?? null;

const E2E_DIR = join(import.meta.dir, "../test/e2e");
const FIXTURES_DIR = join(E2E_DIR, "fixtures");
const NPM_ENV = {
  ...process.env,
  npm_config_user_agent: `npm/10 node/${process.version} ${process.platform} ${process.arch}`,
};

async function resolveNpmDependencyVersion(name: string, spec: string): Promise<string> {
  const packageSpec = `${name}@${spec}`;
  const result = await Bun.$`npm view ${packageSpec} version --json`.env(NPM_ENV).quiet().nothrow();

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resolve ${packageSpec}:\n${result.stderr.toString() || result.stdout.toString()}`,
    );
  }

  const version = JSON.parse(result.stdout.toString()) as string | string[];
  if (Array.isArray(version)) {
    const highest = semver.rsort(version)[0];
    if (!highest) throw new Error(`No versions resolved for ${packageSpec}`);
    return highest;
  }

  return version;
}

// Ensure fixtures directory exists
await mkdir(FIXTURES_DIR, { recursive: true });

const glob = new Glob("*.test.ts");
const testFiles: string[] = [];
for await (const file of glob.scan(E2E_DIR)) {
  testFiles.push(join(E2E_DIR, file));
}

const fixtureNames: string[] = [];
let matchedOnly = false;

for (const testFile of testFiles) {
  const name = basename(testFile, ".test.ts");
  fixtureNames.push(name);
  const fixtureDir = join(FIXTURES_DIR, name);

  if (onlyName && name !== onlyName) continue;
  matchedOnly = true;

  const { config } = (await import(testFile)) as {
    config?: import("../test/e2e/lib/types.ts").FixtureConfig;
  };

  // Skip non-fixture e2e tests (e.g. live-API roundtrip tests that don't
  // scaffold a project and therefore don't export a FixtureConfig).
  if (!config) {
    if (onlyName) {
      console.error(`❌ ${name} is not a fixture (no config export).`);
      process.exit(1);
    }
    continue;
  }

  console.log(`🔄 Refreshing: ${name}`);

  // Use a lowercase-only suffix so framework scaffolders (e.g. create-next-app)
  // don't reject the directory name due to uppercase characters.
  const suffix = Math.random().toString(36).slice(2, 8);
  const tmpProject = join(tmpdir(), `clerk-fixture-${name}-${suffix}`);
  await mkdir(tmpProject, { recursive: true });

  try {
    // Scaffold the framework project
    const scaffold = await Bun.$`${config.scaffoldCmd}`.cwd(tmpProject).env(NPM_ENV).nothrow();

    if (scaffold.exitCode !== 0) {
      console.error(`❌ Scaffold failed for ${name}:\n${scaffold.stderr.toString()}`);
      continue;
    }

    // Add Clerk SDK to dependencies and normalize the package name to a
    // stable value so re-scaffolds don't produce noisy diffs from the
    // random temp directory suffix that scaffolders pick up.
    const pkgPath = join(tmpProject, "package.json");
    const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    pkg.name = `clerk-fixture-${name}`;
    pkg.dependencies ??= {};
    pkg.dependencies[config.clerkSdk] = "latest";
    assertPinnedDependencyRanges(pkg, config.pinnedDependencyRanges, name);
    applyPackageJsonOverrides(pkg, config.packageJsonOverrides);
    await resolveDependencySpecsToExactVersions(pkg, resolveNpmDependencyVersion);
    assertPinnedDependencyRanges(pkg, config.pinnedDependencyRanges, name);
    await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const lockfile =
      await Bun.$`npm install --package-lock-only --ignore-scripts --legacy-peer-deps`
        .cwd(tmpProject)
        .env(NPM_ENV)
        .quiet()
        .nothrow();
    if (lockfile.exitCode !== 0) {
      throw new Error(`package-lock generation failed for ${name}:\n${lockfile.stderr.toString()}`);
    }

    // Strip generated artifacts that shouldn't be committed
    const toRemove = [
      "node_modules",
      ".git",
      ".next",
      "dist",
      "out",
      ".nuxt",
      ".output",
      ".vscode",
      ".cta.json",
      "Dockerfile",
      ".dockerignore",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ];
    for (const entry of toRemove) {
      await rm(join(tmpProject, entry), { recursive: true, force: true });
    }

    // Copy generated files into fixture dir
    await rm(fixtureDir, { recursive: true, force: true });
    await mkdir(fixtureDir, { recursive: true });
    await cp(tmpProject, fixtureDir, { recursive: true });

    console.log(`✅ Done: ${name}`);
  } finally {
    await rm(tmpProject, { recursive: true, force: true });
  }
}

if (onlyName && !matchedOnly) {
  console.error(
    `⚠️  --only "${onlyName}" did not match any fixture. Available: ${fixtureNames.join(", ")}`,
  );
  process.exit(1);
}
