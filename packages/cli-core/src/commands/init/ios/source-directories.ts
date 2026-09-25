import { extname } from "node:path";

// Xcode treats these directory packages as resources, not source subfolders.
const OPAQUE_SOURCE_DIRECTORY_EXTENSIONS = new Set([
  ".bundle",
  ".docc",
  ".lproj",
  ".playground",
  ".xcassets",
  ".xcdatamodeld",
  ".xcplaygroundpage",
]);

export function shouldTraverseSynchronizedSourceDirectory(name: string): boolean {
  // Conventional build/dependency names and hidden folders can contain shipping
  // Swift. Only Xcode's metadata and known resource packages are excluded here;
  // target membership and explicit file-type overrides are checked by callers.
  return name !== ".git" && !OPAQUE_SOURCE_DIRECTORY_EXTENSIONS.has(extname(name).toLowerCase());
}
