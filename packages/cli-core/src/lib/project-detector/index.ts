/**
 * ProjectDetector collaborator.
 *
 * Folds the previous `commands/init/context.ts` and the I/O parts of
 * `lib/framework.ts` into a single namespace exposed via the deps registry.
 * Owns:
 *
 * - High-level `gather(cwd, override?)` that builds a `ProjectContext`.
 * - Low-level filesystem probes (`fileExists`, `dirExists`).
 * - The framework-specific enrichers (currently only Next.js).
 * - The package.json reader (`readDeps`) and framework auto-detection
 *   (`detectFramework`).
 *
 * The pure parts of `lib/framework.ts` (`FRAMEWORK_NAMES`, `lookupFramework`,
 * `FrameworkInfo`) stay in `lib/framework.ts`. Wrapper helpers like
 * `detectPublishableKeyName` re-export from this module to share the cached
 * detection logic.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { FRAMEWORK_MAP } from "../framework.ts";
import type { FrameworkInfo } from "../framework.ts";
import { findExistingEnvFile } from "../dotenv.ts";
import type { ProjectContext } from "../../commands/init/frameworks/types.ts";
import type { PackageManager } from "../../commands/init/bootstrap-registry.ts";

export interface ProjectDetector {
  gather(cwd: string, override?: FrameworkInfo): Promise<ProjectContext | null>;
  fileExists(path: string): Promise<boolean>;
  dirExists(path: string): Promise<boolean>;
  readDeps(cwd: string): Promise<Record<string, string> | null>;
  detectFramework(cwd: string): Promise<FrameworkInfo | null>;
  hasPackageJson(cwd: string): Promise<boolean>;
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readDeps(cwd: string): Promise<Record<string, string> | null> {
  const file = Bun.file(join(cwd, "package.json"));
  if (!(await file.exists())) return null;

  try {
    const pkg = await file.json();
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
}

export async function detectFramework(cwd: string): Promise<FrameworkInfo | null> {
  const allDeps = await readDeps(cwd);
  if (!allDeps) return null;

  for (const fw of FRAMEWORK_MAP) {
    if (fw.dep in allDeps) return fw;
  }

  return null;
}

async function detectPackageManager(cwd: string): Promise<ProjectContext["packageManager"]> {
  const checks: Array<{ files: string[]; pm: ProjectContext["packageManager"] }> = [
    { files: ["bun.lockb", "bun.lock"], pm: "bun" },
    { files: ["yarn.lock"], pm: "yarn" },
    { files: ["pnpm-lock.yaml"], pm: "pnpm" },
  ];

  for (const { files, pm } of checks) {
    for (const file of files) {
      if (await fileExists(join(cwd, file))) return pm;
    }
  }
  return "npm";
}

export async function hasPackageJson(cwd: string): Promise<boolean> {
  return fileExists(join(cwd, "package.json"));
}

export async function gather(
  cwd: string,
  frameworkOverride?: FrameworkInfo,
  pmOverride?: PackageManager,
): Promise<ProjectContext | null> {
  const framework = frameworkOverride ?? (await detectFramework(cwd));
  if (!framework) return null;

  const typescript = await fileExists(join(cwd, "tsconfig.json"));

  const [rootAppDir, rootPagesDir, srcDirExists] = await Promise.all([
    dirExists(join(cwd, "app")),
    dirExists(join(cwd, "pages")),
    dirExists(join(cwd, "src")),
  ]);

  // Use src/ convention when a src/ directory exists and no root-level app/pages dirs are present.
  // Works for both Next.js-style (src/app, src/pages) and React/Vite-style (bare src/) projects
  // because src/app or src/pages existing implies src/ exists.
  const hasRootStructure = rootAppDir || rootPagesDir;
  const srcDir = srcDirExists && !hasRootStructure;

  const packageManager = pmOverride ?? (await detectPackageManager(cwd));

  const deps = await readDeps(cwd);
  const existingClerk = deps ? framework.sdk in deps : false;

  const envFile = await findExistingEnvFile(cwd, framework.envFile);

  return {
    cwd,
    framework,
    typescript,
    srcDir,
    packageManager,
    existingClerk,
    deps: deps ?? {},
    envFile,
  };
}

export function createProjectDetector(): ProjectDetector {
  return { gather, fileExists, dirExists, readDeps, detectFramework, hasPackageJson };
}
