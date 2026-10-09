/**
 * Loading a user-authored source at runtime.
 *
 * In the standalone migration-tool, supporting a new platform meant adding a
 * file to `src/transformers/` and one line to the registry — the user had the
 * source tree. A compiled binary has neither a source tree to edit nor a way
 * for an end user to rebuild it, so `--source <path>` restores that
 * extensibility by importing a file from the user's own project instead.
 *
 * **Verified before this was built on:** a `bun build --compile` executable can
 * `import()` an arbitrary external `.ts` file at runtime, including TypeScript
 * that needs transpiling. Bun's transpiler is part of the runtime, not only the
 * bundler. Confirmed with a throwaway compiled binary on darwin-arm64,
 * linux-arm64 (glibc), linux-arm64-musl and linux-x64.
 *
 * The file is user-supplied code the CLI executes, so its shape is validated
 * up front and rejected with a specific message rather than crashing deep in
 * the transform pipeline on a missing field.
 */

import fs from "node:fs";
import path from "node:path";
import { CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.ts";
import type { CarryLevel, SourceEntry } from "../types.ts";

const DOCS_URL = "https://clerk.com/docs/guides/development/migrating/overview";

const LEVELS: readonly CarryLevel[] = ["yes", "no", "partial"];

function invalid(problem: string, file: string): never {
  throwUsageError(`${file} is not a valid source: ${problem}`, DOCS_URL);
}

/**
 * Checks a loaded value against the registry entry shape.
 *
 * Every failure names the specific field and what was wrong with it — the
 * author is writing this file by hand against a shape they cannot see.
 *
 * @param file - Path as the user typed it, for the error message.
 * @param reservedKeys - The built-in keys, which a custom source may not reuse.
 */
export function validateSource(
  value: unknown,
  file: string,
  reservedKeys: readonly string[] = [],
): SourceEntry {
  if (value === null || typeof value !== "object") {
    invalid(`the default export is ${value === null ? "null" : typeof value}, not an object`, file);
  }

  const entry = value as Record<string, unknown>;

  for (const field of ["key", "label"] as const) {
    if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
      invalid(`\`${field}\` must be a non-empty string`, file);
    }
  }

  if (entry.description !== undefined && typeof entry.description !== "string") {
    invalid("`description` must be a string when present", file);
  }

  // Arrays are objects, and an author who wrote `transformer: []` should hear
  // that rather than the downstream "no field maps to userId".
  if (
    entry.transformer === null ||
    typeof entry.transformer !== "object" ||
    Array.isArray(entry.transformer)
  ) {
    invalid("`transformer` must be an object mapping source fields to Clerk fields", file);
  }

  const mapping = entry.transformer as Record<string, unknown>;
  for (const [source, target] of Object.entries(mapping)) {
    if (typeof target !== "string" || target.length === 0) {
      invalid(
        `\`transformer.${source}\` must map to a Clerk field name, got ${typeof target}`,
        file,
      );
    }
  }

  // Without this the import runs to completion and creates every user with no
  // external_id, which is what makes a migration re-runnable and reversible.
  if (!Object.values(mapping).includes("userId")) {
    invalid(
      "no source field maps to `userId`. Every user needs one — it becomes the Clerk user's external_id",
      file,
    );
  }

  if (
    entry.defaults !== undefined &&
    (entry.defaults === null || typeof entry.defaults !== "object" || Array.isArray(entry.defaults))
  ) {
    invalid("`defaults` must be an object when present", file);
  }

  // What a source brings across is the first thing `sources` shows, and the
  // author is the only one who knows it.
  const carries = entry.carries as Record<string, unknown> | undefined;
  if (!carries || typeof carries !== "object" || Array.isArray(carries)) {
    invalid(
      "`carries` must say what the source brings across: { passwords, mfa, metadata }, each { level, note }",
      file,
    );
  }
  for (const kind of ["passwords", "mfa", "metadata"] as const) {
    const carry = carries[kind] as { level?: unknown; note?: unknown } | undefined;
    if (!carry || !LEVELS.includes(carry.level as CarryLevel) || typeof carry.note !== "string") {
      invalid(
        `\`carries.${kind}\` must be { level: "yes" | "no" | "partial", note: string }`,
        file,
      );
    }
  }

  for (const hook of ["preTransform", "postTransform"] as const) {
    if (entry[hook] !== undefined && typeof entry[hook] !== "function") {
      invalid(`\`${hook}\` must be a function when present`, file);
    }
  }

  if (reservedKeys.includes(entry.key as string)) {
    invalid(
      `\`key\` is "${String(entry.key)}", which is already a built-in source. Choose another key`,
      file,
    );
  }

  return {
    ...(entry as unknown as SourceEntry),
    description: (entry.description as string | undefined) ?? "Custom source",
  };
}

/**
 * Imports and validates a user-authored source.
 *
 * @throws CliError when the path is missing, the module fails to load, or the
 *   exported value does not match the registry entry shape.
 */
export async function loadCustomSource(
  file: string,
  reservedKeys: readonly string[] = [],
  /**
   * The file's content hash. The module loader caches by URL, so an edited
   * file at the same path would load the old module; the hash in the URL
   * loads the version that was hashed.
   */
  version?: string,
): Promise<SourceEntry> {
  const resolved = path.resolve(process.cwd(), file);

  if (!fs.existsSync(resolved)) {
    throw new CliError(`No source file at ${resolved}.`, {
      code: ERROR_CODE.FILE_NOT_FOUND,
      docsUrl: DOCS_URL,
    });
  }
  if (fs.statSync(resolved).isDirectory()) {
    throwUsageError(`${resolved} is a directory, not a source file.`);
  }

  let module: Record<string, unknown>;
  try {
    // A file URL rather than a bare path: an absolute POSIX path happens to
    // work, but a Windows path (`C:\...`) is not a valid import specifier.
    // Bun keys its module cache by specifier and keeps a `file://` URL's
    // module whatever its query, but a plain path's query loads afresh.
    // ponytail: Windows keeps the URL form, so an edit loaded twice in one
    // process reuses the first; each CLI run is a process of its own.
    const specifier =
      version && process.platform !== "win32"
        ? `${resolved}?v=${version}`
        : Bun.pathToFileURL(resolved).href;
    module = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    throwUsageError(
      `Could not load ${file}: ${(error as Error).message}\n` +
        "The file must be valid JavaScript or TypeScript that this CLI can import.",
      DOCS_URL,
    );
  }

  if (module.default === undefined) {
    // Point at what they probably meant rather than just restating the rule.
    const named = Object.keys(module).filter((key) => key !== "default");
    const hint =
      named.length > 0
        ? ` Found named export${named.length === 1 ? "" : "s"} ${named.map((n) => `\`${n}\``).join(", ")} — did you mean \`export default\`?`
        : "";
    throwUsageError(`${file} has no default export.${hint}`, DOCS_URL);
  }

  return validateSource(module.default, file, reservedKeys);
}
