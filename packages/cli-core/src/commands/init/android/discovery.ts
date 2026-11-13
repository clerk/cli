import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../../lib/errors.ts";
import { containedPath, snapshotFile, type FileSnapshot } from "./files.ts";
import { catalogAccessor, maskCode, parseCatalog, usesAccessor, type Catalog } from "./gradle.ts";
import { unsupported } from "./types.ts";

export interface ModuleChoice {
  /** The module directory, relative to the project root (`.` for a single-module root). */
  module: string;
  buildPath: string;
}
export type ChooseModule = (choices: ModuleChoice[]) => Promise<ModuleChoice>;
export class SelectionNeeded extends CliError {
  constructor(public choices: ModuleChoice[]) {
    super(
      `Choose an Android application module with --android-module: ${choices.map((choice) => choice.module).join(", ") || "none found"}.`,
      { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE },
    );
  }
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".clerk",
  "build",
  "node_modules",
]);
const MANIFEST = join("src", "main", "AndroidManifest.xml");

/** `module/path`, without a leading `./` for the root module. */
export function modulePath(module: string, path: string): string {
  return module === "." ? path : join(module, path);
}

/** Whether a build script applies `com.android.application`, literally or through a catalog alias. */
export function appliesApplicationPlugin(build: string, catalog?: Catalog): boolean {
  if (/["']com\.android\.application["']/.test(maskCode(build, false))) return true;
  return Object.entries(catalog?.plugins ?? {}).some(
    ([alias, plugin]) =>
      plugin.id === "com.android.application" &&
      usesAccessor(build, catalogAccessor(alias, "plugins")),
  );
}

/** The module's one build script, or undefined when it has none. Two scripts are unsupported. */
async function buildScriptPath(root: string, module: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const name of ["build.gradle.kts", "build.gradle"]) {
    const path = modulePath(module, name);
    if (await Bun.file(join(root, path)).exists()) candidates.push(path);
  }
  if (candidates.length > 1)
    throw unsupported(`${module} has both build.gradle.kts and build.gradle.`);
  return candidates[0];
}

/**
 * Android application modules under the root: directories with `src/main/AndroidManifest.xml`
 * whose build script applies the application plugin. Library modules and build output are skipped.
 */
export async function findApplicationModules(
  root: string,
  catalog?: Catalog,
): Promise<ModuleChoice[]> {
  if (!catalog && (await Bun.file(join(root, "gradle/libs.versions.toml")).exists()))
    catalog = parseCatalog((await snapshotFile(root, "gradle/libs.versions.toml")).source);
  const found: ModuleChoice[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    const module = relative(root, dir) || ".";
    if (await Bun.file(join(dir, MANIFEST)).exists()) {
      const buildPath = await buildScriptPath(root, module);
      if (buildPath) {
        const build = (await snapshotFile(root, buildPath)).source;
        if (appliesApplicationPlugin(build, catalog)) found.push({ module, buildPath });
      }
    }
    if (depth >= 3) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Symbolic links are never followed; the files module refuses to edit through them.
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name) || entry.name === "src")
        continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

export async function selectModule(
  root: string,
  catalog: Catalog | undefined,
  supplied?: string,
  choose?: ChooseModule,
): Promise<ModuleChoice & { build: FileSnapshot }> {
  let choice: ModuleChoice;
  if (supplied) {
    const contained = await containedPath(root, supplied === "." ? "." : supplied).catch(
      (error: unknown) => {
        if (supplied === ".") return root;
        throw error;
      },
    );
    const module = relative(root, contained).split(sep).join("/") || ".";
    if (!(await Bun.file(join(root, modulePath(module, MANIFEST))).exists()))
      throw unsupported(`--android-module ${supplied} has no src/main/AndroidManifest.xml.`);
    const buildPath = await buildScriptPath(root, module);
    if (!buildPath) throw unsupported(`--android-module ${supplied} has no Gradle build script.`);
    choice = { module, buildPath };
  } else {
    const candidates = await findApplicationModules(root, catalog);
    if (candidates.length === 1) choice = candidates[0]!;
    else {
      if (!choose || !candidates.length) throw new SelectionNeeded(candidates);
      const picked = await choose(candidates);
      const match = candidates.find((item) => item.module === picked.module);
      if (!match) throw new SelectionNeeded(candidates);
      choice = match;
    }
  }
  const build = await snapshotFile(root, choice.buildPath);
  if (!appliesApplicationPlugin(build.source, catalog))
    throw unsupported(
      `${choice.buildPath} doesn't apply com.android.application; select an application module.`,
    );
  return { ...choice, build };
}
