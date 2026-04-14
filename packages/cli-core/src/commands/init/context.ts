import { join } from "node:path";
import { stat } from "node:fs/promises";
import { detectFramework, readDeps } from "../../lib/framework.js";
import type { FrameworkInfo } from "../../lib/framework.js";
import { findExistingEnvFile } from "../../lib/dotenv.js";
import type { ProjectContext } from "./frameworks/types.js";
import type { PackageManager } from "./bootstrap-registry.js";

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

// Re-export for modules that import readDeps from context (e.g., format.ts)
export { readDeps } from "../../lib/framework.js";

export async function hasPackageJson(cwd: string): Promise<boolean> {
  return fileExists(join(cwd, "package.json"));
}

export async function gatherContext(
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
