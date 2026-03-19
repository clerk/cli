import { join } from "node:path";
import { stat } from "node:fs/promises";
import { detectFramework, readDeps } from "../../lib/framework.js";
import type { ProjectContext } from "./frameworks/types.js";

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

export async function gatherContext(cwd: string): Promise<ProjectContext | null> {
  const framework = await detectFramework(cwd);
  if (!framework) return null;

  const typescript = await fileExists(join(cwd, "tsconfig.json"));

  const [srcAppDir, srcPagesDir, rootAppDir, rootPagesDir] = await Promise.all([
    dirExists(join(cwd, "src/app")),
    dirExists(join(cwd, "src/pages")),
    dirExists(join(cwd, "app")),
    dirExists(join(cwd, "pages")),
  ]);

  // Use src/ convention only when app/pages dirs exist in src/ but NOT in root
  const hasSrcStructure = srcAppDir || srcPagesDir;
  const hasRootStructure = rootAppDir || rootPagesDir;
  const srcDir = hasSrcStructure && !hasRootStructure;

  const packageManager = await detectPackageManager(cwd);

  const deps = await readDeps(cwd);
  const existingClerk = deps ? Object.keys(deps).some((d) => d.startsWith("@clerk/")) : false;

  const envFile = (await fileExists(join(cwd, ".env.local"))) ? ".env.local" : ".env";

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
