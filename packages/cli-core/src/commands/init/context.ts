import { join } from "node:path";
import { stat } from "node:fs/promises";
import { detectFramework, readDeps } from "../../lib/framework.js";
import { findFirstFile } from "./frameworks/helpers.js";
import type { ProjectContext } from "./frameworks/types.js";

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function dirExists(path: string): Promise<boolean> {
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

/**
 * Parse the major version from a semver-like string.
 * Handles: "15.0.0", "^15.0.0", "~15.0.0", ">=15", etc.
 * Returns null for non-numeric versions like "latest", "canary", "*".
 */
export function parseNextMajorVersion(version: string): number | null {
  const match = version.match(/(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Determine the correct middleware filename for a Next.js project.
 * Next.js 16+ uses proxy.ts, ≤15 uses middleware.ts.
 *
 * Priority: existing file > version-based > default to proxy (latest convention).
 */
async function detectMiddlewareBasename(
  cwd: string,
  srcDir: boolean,
  ext: string,
  nextVersion: string | undefined,
): Promise<ProjectContext["middlewareBasename"]> {
  const base = srcDir ? "src/" : "";

  // Existing file takes precedence
  if (await fileExists(join(cwd, `${base}proxy.${ext}`))) return "proxy";
  if (await fileExists(join(cwd, `${base}middleware.${ext}`))) return "middleware";

  // Fall back to version detection
  if (!nextVersion) return "proxy";

  const major = parseNextMajorVersion(nextVersion);
  if (major === null) return "proxy"; // Unknown version (e.g., "latest", "*")

  return major >= 16 ? "proxy" : "middleware";
}

async function detectLayoutPath(
  cwd: string,
  dep: string,
  variant: ProjectContext["variant"],
  srcDir: boolean,
  ext: string,
): Promise<string | null> {
  const base = srcDir ? "src/" : "";

  if (dep === "next") {
    if (variant === "pages-router") {
      return findFirstFile(cwd, [`${base}pages/_app.${ext}x`, `${base}pages/_app.${ext}`]);
    }
    return findFirstFile(cwd, [`${base}app/layout.${ext}x`, `${base}app/layout.${ext}`]);
  }

  return null;
}

function detectNextjsVariant(
  dep: string,
  dirs: {
    srcDir: boolean;
    srcAppDir: boolean;
    srcPagesDir: boolean;
    rootAppDir: boolean;
    rootPagesDir: boolean;
  },
): ProjectContext["variant"] {
  if (dep !== "next") return null;

  const appExists = dirs.srcDir ? dirs.srcAppDir : dirs.rootAppDir;
  if (appExists) return "app-router";

  const pagesExists = dirs.srcDir ? dirs.srcPagesDir : dirs.rootPagesDir;
  if (pagesExists) return "pages-router";

  return "app-router"; // Default for new Next.js projects
}

export async function gatherContext(cwd: string): Promise<ProjectContext | null> {
  const framework = await detectFramework(cwd);
  if (!framework) return null;

  const typescript = await fileExists(join(cwd, "tsconfig.json"));
  const ext = typescript ? "ts" : "js";

  const srcAppDir = await dirExists(join(cwd, "src/app"));
  const srcPagesDir = await dirExists(join(cwd, "src/pages"));
  const rootAppDir = await dirExists(join(cwd, "app"));
  const rootPagesDir = await dirExists(join(cwd, "pages"));

  // Use src/ convention only when app/pages dirs exist in src/ but NOT in root
  const hasSrcStructure = srcAppDir || srcPagesDir;
  const hasRootStructure = rootAppDir || rootPagesDir;
  const srcDir = hasSrcStructure && !hasRootStructure;

  const variant = detectNextjsVariant(framework.dep, {
    srcDir,
    srcAppDir,
    srcPagesDir,
    rootAppDir,
    rootPagesDir,
  });

  const packageManager = await detectPackageManager(cwd);

  const deps = await readDeps(cwd);
  const existingClerk = deps ? Object.keys(deps).some((d) => d.startsWith("@clerk/")) : false;

  const layoutPath = await detectLayoutPath(cwd, framework.dep, variant, srcDir, ext);

  const envFile = (await fileExists(join(cwd, ".env.local"))) ? ".env.local" : ".env";

  const middlewareBasename =
    framework.dep === "next"
      ? await detectMiddlewareBasename(cwd, srcDir, ext, deps?.[framework.dep])
      : ("middleware" as const);

  return {
    cwd,
    framework,
    variant,
    typescript,
    srcDir,
    packageManager,
    existingClerk,
    deps: deps ?? {},
    layoutPath,
    envFile,
    middlewareBasename,
  };
}
