#!/usr/bin/env bun
/**
 * Regenerates e2e fixture directories from real framework CLI tools.
 *
 * Reads the fixture catalog from `test/e2e/fixtures.manifest.ts`, which is
 * the single source of truth for both this script and the test files. The
 * script never imports the test files themselves, so it doesn't depend on
 * `bun:test` being available at module load.
 *
 * Usage:
 *   bun run scripts/refresh-e2e-fixtures.ts           # refresh every fixture
 *   bun run scripts/refresh-e2e-fixtures.ts --only nextjs-app-router
 */

import { rm, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import semver from "semver";
import {
  applyPackageJsonOverrides,
  assertPinnedDependencyRanges,
  resolveDependencySpecsToExactVersions,
} from "./lib/fixture-deps.ts";
import { fixtures } from "../test/e2e/fixtures.manifest.ts";
import type { FixtureConfig } from "../test/e2e/lib/types.ts";

const E2E_DIR = join(import.meta.dir, "../test/e2e");
const DEFAULT_FIXTURES_DIR = join(E2E_DIR, "fixtures");
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

type FixtureEntry = [string, FixtureConfig];

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type ScaffoldRunner = (
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
) => Promise<CommandResult>;

type RefreshFixturesOptions = {
  onlyName?: string | null;
  entries?: FixtureEntry[];
  fixturesDir?: string;
  tmpRoot?: string;
  env?: Record<string, string | undefined>;
  runScaffold?: ScaffoldRunner;
  resolveDependencyVersion?: (name: string, spec: string) => Promise<string>;
};

type RefreshFixturesResult = {
  failedFixtures: string[];
};

async function runScaffoldCommand(
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CommandResult> {
  const result = await Bun.$`${command}`.cwd(cwd).env(env).nothrow();
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

/**
 * Regenerate e2e fixtures from the configured framework scaffolders.
 *
 * Scaffold command failures are collected so every requested fixture gets an
 * attempt before the caller decides whether to exit non-zero.
 */
export async function refreshFixtures({
  onlyName = null,
  entries = Object.entries(fixtures) as FixtureEntry[],
  fixturesDir = DEFAULT_FIXTURES_DIR,
  tmpRoot = tmpdir(),
  env = NPM_ENV,
  runScaffold = runScaffoldCommand,
  resolveDependencyVersion = resolveNpmDependencyVersion,
}: RefreshFixturesOptions = {}): Promise<RefreshFixturesResult> {
  await mkdir(fixturesDir, { recursive: true });

  if (onlyName && !entries.some(([name]) => name === onlyName)) {
    throw new Error(
      `⚠️  --only "${onlyName}" did not match any fixture. Available: ${entries.map(([name]) => name).join(", ")}`,
    );
  }

  const failedFixtures: string[] = [];

  for (const [name, config] of entries) {
    if (onlyName && name !== onlyName) continue;

    const fixtureDir = join(fixturesDir, name);
    console.log(`🔄 Refreshing: ${name}`);

    // Use a lowercase-only suffix so framework scaffolders (e.g. create-next-app)
    // don't reject the directory name due to uppercase characters.
    const suffix = Math.random().toString(36).slice(2, 8);
    const tmpProject = join(tmpRoot, `clerk-fixture-${name}-${suffix}`);
    await mkdir(tmpProject, { recursive: true });

    try {
      // Scaffold the framework project
      const scaffold = await runScaffold(config.scaffoldCmd, tmpProject, env);

      if (scaffold.exitCode !== 0) {
        failedFixtures.push(name);
        console.error(`❌ Scaffold failed for ${name}:\n${scaffold.stderr || scaffold.stdout}`);
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
      await resolveDependencySpecsToExactVersions(pkg, resolveDependencyVersion);
      assertPinnedDependencyRanges(pkg, config.pinnedDependencyRanges, name);
      await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

      const lockfile =
        await Bun.$`npm install --package-lock-only --ignore-scripts --legacy-peer-deps`
          .cwd(tmpProject)
          .env(env)
          .quiet()
          .nothrow();
      if (lockfile.exitCode !== 0) {
        throw new Error(
          `package-lock generation failed for ${name}:\n${lockfile.stderr.toString()}`,
        );
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

  if (failedFixtures.length > 0) {
    console.error(`❌ Fixture refresh failed for: ${failedFixtures.join(", ")}`);
  }

  return { failedFixtures };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      only: { type: "string" },
    },
    strict: true,
  });

  try {
    const result = await refreshFixtures({ onlyName: values.only ?? null });
    if (result.failedFixtures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
