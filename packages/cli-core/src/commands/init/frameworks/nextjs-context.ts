import { join } from "node:path";
import { fileExists, dirExists } from "../context.js";
import { findFirstFile, resolveNextjsMiddlewareBasename, scriptExt, srcPrefix } from "./helpers.js";
import type { ProjectContext } from "./types.js";

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
): Promise<NonNullable<ProjectContext["middlewareBasename"]>> {
  const base = srcPrefix({ srcDir });

  // Existing file takes precedence
  if (await fileExists(join(cwd, `${base}proxy.${ext}`))) return "proxy";
  if (await fileExists(join(cwd, `${base}middleware.${ext}`))) return "middleware";

  return resolveNextjsMiddlewareBasename(nextVersion);
}

function detectNextjsVariant(dirs: {
  srcDir: boolean;
  srcAppDir: boolean;
  srcPagesDir: boolean;
  rootAppDir: boolean;
  rootPagesDir: boolean;
}): NonNullable<ProjectContext["variant"]> {
  const appExists = dirs.srcDir ? dirs.srcAppDir : dirs.rootAppDir;
  if (appExists) return "app-router";

  const pagesExists = dirs.srcDir ? dirs.srcPagesDir : dirs.rootPagesDir;
  if (pagesExists) return "pages-router";

  return "app-router"; // Default for new Next.js projects
}

async function detectLayoutPath(
  cwd: string,
  variant: ProjectContext["variant"],
  srcDir: boolean,
  ext: string,
): Promise<string | null> {
  const base = srcPrefix({ srcDir });

  if (variant === "pages-router") {
    return findFirstFile(cwd, [`${base}pages/_app.${ext}x`, `${base}pages/_app.${ext}`]);
  }
  return findFirstFile(cwd, [`${base}app/layout.${ext}x`, `${base}app/layout.${ext}`]);
}

/**
 * Enrich a ProjectContext with Next.js-specific fields:
 * variant, layoutPath, middlewareBasename.
 */
export async function enrichNextjsContext(ctx: ProjectContext): Promise<void> {
  const ext = scriptExt(ctx);

  const [srcAppDir, srcPagesDir, rootAppDir, rootPagesDir] = await Promise.all([
    dirExists(join(ctx.cwd, "src/app")),
    dirExists(join(ctx.cwd, "src/pages")),
    dirExists(join(ctx.cwd, "app")),
    dirExists(join(ctx.cwd, "pages")),
  ]);

  ctx.variant = detectNextjsVariant({
    srcDir: ctx.srcDir,
    srcAppDir,
    srcPagesDir,
    rootAppDir,
    rootPagesDir,
  });

  ctx.layoutPath = await detectLayoutPath(ctx.cwd, ctx.variant, ctx.srcDir, ext);

  ctx.middlewareBasename = await detectMiddlewareBasename(
    ctx.cwd,
    ctx.srcDir,
    ext,
    ctx.deps[ctx.framework.dep],
  );
}
