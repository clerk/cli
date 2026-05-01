import { basename, join } from "node:path";

const APP_NAME_MAX_CHARS = 50;

function truncateToChars(str: string, max: number): string {
  const segments = [...new Intl.Segmenter().segment(str)];
  return segments.length <= max
    ? str
    : segments
        .slice(0, max)
        .map((s) => s.segment)
        .join("");
}

/**
 * Derives a Clerk application name from the current project. Reads
 * `package.json#name` first, then falls back to the directory basename.
 * Result is truncated to a length safe for the PLAPI app-name field.
 */
export async function deriveProjectName(cwd: string, override?: string): Promise<string> {
  if (override?.trim()) return truncateToChars(override.trim(), APP_NAME_MAX_CHARS);

  try {
    const pkg: { name?: unknown } = await Bun.file(join(cwd, "package.json")).json();
    if (typeof pkg.name === "string" && pkg.name.trim()) {
      return truncateToChars(pkg.name.trim(), APP_NAME_MAX_CHARS);
    }
  } catch {
    // fall through
  }
  return truncateToChars(basename(cwd), APP_NAME_MAX_CHARS);
}
