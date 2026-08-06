/**
 * Loading a user-authored transformer at runtime.
 *
 * In the standalone migration-tool, supporting a new platform meant adding a
 * file to `src/transformers/` and one line to the registry — the user had the
 * source tree. A compiled binary has neither a source tree to edit nor a way
 * for an end user to rebuild it, so `--transformer-file` restores that
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
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import type { TransformerRegistryEntry } from "../types.ts";
import { transformers } from "./registry.ts";

const DOCS_URL = "https://clerk.com/docs/guides/development/migrating/overview";

function invalid(problem: string, file: string): never {
  throw new CliError(`${file} is not a valid transformer: ${problem}`, {
    code: ERROR_CODE.USAGE_ERROR,
    docsUrl: DOCS_URL,
  });
}

/**
 * Checks a loaded value against the registry entry shape.
 *
 * Every failure names the specific field and what was wrong with it — the
 * author is writing this file by hand against a shape they cannot see.
 *
 * @param file - Path as the user typed it, for the error message.
 */
export function validateTransformer(value: unknown, file: string): TransformerRegistryEntry {
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

  for (const hook of ["preTransform", "postTransform"] as const) {
    if (entry[hook] !== undefined && typeof entry[hook] !== "function") {
      invalid(`\`${hook}\` must be a function when present`, file);
    }
  }

  if (transformers.some((builtIn) => builtIn.key === entry.key)) {
    invalid(
      `\`key\` is "${String(entry.key)}", which is already a built-in transformer. Choose another key`,
      file,
    );
  }

  return {
    ...(entry as unknown as TransformerRegistryEntry),
    description: (entry.description as string | undefined) ?? "Custom transformer",
  };
}

/**
 * Imports and validates a user-authored transformer.
 *
 * @throws CliError when the path is missing, the module fails to load, or the
 *   exported value does not match the registry entry shape.
 */
export async function loadCustomTransformer(file: string): Promise<TransformerRegistryEntry> {
  const resolved = path.resolve(process.cwd(), file);

  if (!fs.existsSync(resolved)) {
    throw new CliError(`No transformer file at ${resolved}.`, {
      code: ERROR_CODE.FILE_NOT_FOUND,
      docsUrl: DOCS_URL,
    });
  }
  if (fs.statSync(resolved).isDirectory()) {
    throw new CliError(`${resolved} is a directory, not a transformer file.`, {
      code: ERROR_CODE.USAGE_ERROR,
    });
  }

  let module: Record<string, unknown>;
  try {
    // A file URL rather than a bare path: an absolute POSIX path happens to
    // work, but a Windows path (`C:\...`) is not a valid import specifier.
    module = (await import(Bun.pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (error) {
    throw new CliError(
      `Could not load ${file}: ${(error as Error).message}\n` +
        "The file must be valid JavaScript or TypeScript that this CLI can import.",
      { code: ERROR_CODE.USAGE_ERROR, docsUrl: DOCS_URL },
    );
  }

  if (module.default === undefined) {
    // Point at what they probably meant rather than just restating the rule.
    const named = Object.keys(module).filter((key) => key !== "default");
    const hint =
      named.length > 0
        ? ` Found named export${named.length === 1 ? "" : "s"} ${named.map((n) => `\`${n}\``).join(", ")} — did you mean \`export default\`?`
        : "";
    throw new CliError(`${file} has no default export.${hint}`, {
      code: ERROR_CODE.USAGE_ERROR,
      docsUrl: DOCS_URL,
    });
  }

  return validateTransformer(module.default, file);
}
