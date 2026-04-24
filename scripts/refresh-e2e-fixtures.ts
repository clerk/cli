#!/usr/bin/env bun
/**
 * Regenerates e2e fixture directories from real framework CLI tools.
 *
 * Usage:
 *   bun run scripts/refresh-e2e-fixtures.ts           # refresh all non-pinned
 *   bun run scripts/refresh-e2e-fixtures.ts --force   # include pinned fixtures
 *   bun run scripts/refresh-e2e-fixtures.ts --only nextjs-app-router
 */

import { rm, cp, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { Glob } from "bun";

// Set env var to signal that we're importing fixtures for config reading only,
// not for test registration. This must be set BEFORE importing any fixture files.
process.env.CLERK_REFRESH_FIXTURES = "1";

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyIndex = args.indexOf("--only");
let onlyName: string | null = null;
if (onlyIndex !== -1) {
  const value = args[onlyIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("--only requires a fixture name (e.g. `--only nextjs-app-router`).");
    process.exit(1);
  }
  onlyName = value;
}

const E2E_DIR = join(import.meta.dir, "../test/e2e");
const FIXTURES_DIR = join(E2E_DIR, "fixtures");

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
    config: import("../test/e2e/lib/types.ts").FixtureConfig;
  };

  if (config.pinned && !force) {
    console.log(`⏭  Skipping pinned fixture: ${name} (use --force to refresh)`);
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
    const scaffold = await Bun.$`${config.scaffoldCmd}`.cwd(tmpProject).nothrow();

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
    if (name === "tanstack-start") {
      pkg.devDependencies ??= {};
      // TanStack Start's current scaffold omits this peer dependency even
      // though the Vite plugin imports it during config evaluation.
      pkg.devDependencies["@rsbuild/core"] = "^2.0.0";
    }
    await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

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
      "package-lock.json",
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
