import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathIsSafelyWithinIOSRoot } from "./discovery.ts";

const MAX_PACKAGE_MANIFEST_BYTES = 1_000_000;
const CLERK_PRODUCTS = ["ClerkKit", "ClerkKitUI"] as const;

function swiftManifestWithoutComments(source: string): string {
  const characters = source.split("");
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  };

  let index = 0;
  while (index < characters.length) {
    if (characters[index] === "/" && characters[index + 1] === "/") {
      const start = index;
      index += 2;
      while (index < characters.length && characters[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }
    if (characters[index] === "/" && characters[index + 1] === "*") {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < characters.length && depth > 0) {
        if (characters[index] === "/" && characters[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (characters[index] === "*" && characters[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      blank(start, index);
      continue;
    }

    let hashCount = 0;
    while (characters[index + hashCount] === "#") hashCount += 1;
    const quoteIndex = index + hashCount;
    if (characters[quoteIndex] !== '"') {
      index += 1;
      continue;
    }
    const multiline = characters[quoteIndex + 1] === '"' && characters[quoteIndex + 2] === '"';
    index = quoteIndex + (multiline ? 3 : 1);
    while (index < characters.length) {
      const closesQuote = multiline
        ? characters[index] === '"' &&
          characters[index + 1] === '"' &&
          characters[index + 2] === '"'
        : characters[index] === '"';
      if (closesQuote) {
        const quoteLength = multiline ? 3 : 1;
        let closesHashes = true;
        for (let hash = 0; hash < hashCount; hash += 1) {
          if (characters[index + quoteLength + hash] !== "#") closesHashes = false;
        }
        if (closesHashes) {
          index += quoteLength + hashCount;
          break;
        }
      }
      if (characters[index] === "\\") {
        let escapeHashes = 0;
        while (characters[index + 1 + escapeHashes] === "#") escapeHashes += 1;
        if (escapeHashes === hashCount) {
          index += 2 + escapeHashes;
          continue;
        }
      }
      index += 1;
    }
  }

  return characters.join("");
}

async function safeDirectory(root: string, path: string): Promise<boolean> {
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) return false;
  try {
    const information = await lstat(path);
    return information.isDirectory() && !information.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Verifies the checked-in structure of a local clerk-ios package without
 * resolving dependencies or executing its manifest.
 */
export async function localClerkIOSPackageIsStructurallyValid(
  root: string,
  packagePath: string,
): Promise<boolean> {
  const manifestPath = resolve(packagePath, "Package.swift");
  if (!(await pathIsSafelyWithinIOSRoot(root, manifestPath))) return false;
  const manifest = Bun.file(manifestPath);
  if (!(await manifest.exists()) || manifest.size > MAX_PACKAGE_MANIFEST_BYTES) return false;

  try {
    const source = swiftManifestWithoutComments(await manifest.text());
    if (!/\bPackage\s*\(\s*name\s*:\s*"Clerk"\s*,/s.test(source)) return false;

    for (const product of CLERK_PRODUCTS) {
      const library = new RegExp(
        `\\.library\\s*\\(\\s*name\\s*:\\s*"${product}"\\s*,\\s*targets\\s*:\\s*\\[\\s*"${product}"\\s*\\]\\s*\\)`,
        "s",
      );
      const target = new RegExp(
        `\\.target\\s*\\(\\s*name\\s*:\\s*"${product}"(?:\\s*,|\\s*\\))`,
        "s",
      );
      if (!library.test(source) || !target.test(source)) return false;
      if (!(await safeDirectory(root, resolve(packagePath, "Sources", product)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
