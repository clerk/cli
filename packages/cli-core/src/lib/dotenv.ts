/**
 * Minimal .env file parser and merger.
 * Preserves comments, blank lines, and key ordering when merging new values.
 */

import { join } from "node:path";

/**
 * Env file candidates in Next.js/Vite development load order (highest priority first).
 * Production/test variants (.env.production.local, .env.test.local) are excluded —
 * the CLI always runs in a development-setup context.
 */
export const ENV_FILE_CANDIDATES = [
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
] as const;

export type EnvFileName = (typeof ENV_FILE_CANDIDATES)[number];

/**
 * Returns the first candidate from ENV_FILE_CANDIDATES that exists on disk,
 * or `fallback` if none do.
 */
export async function findExistingEnvFile(
  cwd: string,
  fallback: EnvFileName,
): Promise<EnvFileName> {
  for (const candidate of ENV_FILE_CANDIDATES) {
    if (await Bun.file(join(cwd, candidate)).exists()) return candidate;
  }
  return fallback;
}

export type EnvLine =
  | { type: "comment"; raw: string }
  | { type: "blank" }
  | { type: "entry"; key: string; value: string; raw: string };

const ENTRY_RE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvFile(content: string): EnvLine[] {
  if (!content) return [];
  const raw = content.endsWith("\n") ? content.slice(0, -1) : content;
  return raw.split("\n").map((line): EnvLine => {
    if (line.trim() === "") return { type: "blank" };
    const match = line.match(ENTRY_RE);
    if (!match) return { type: "comment", raw: line };
    const key = match[2];
    if (!key) return { type: "comment", raw: line };
    let value = match[3] ?? "";
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { type: "entry", key, value, raw: line };
  });
}

export function mergeEnvVars(lines: EnvLine[], vars: Record<string, string>): EnvLine[] {
  const remaining = { ...vars };
  const result = lines.map((line): EnvLine => {
    if (line.type !== "entry" || !(line.key in remaining)) return line;
    const value = remaining[line.key];
    if (value === undefined) return line;
    delete remaining[line.key];
    return { type: "entry", key: line.key, value, raw: `${line.key}=${value}` };
  });

  const toAppend = Object.entries(remaining);
  if (toAppend.length === 0) return result;

  // Add a Clerk section header if no Clerk keys existed in the original file
  const hadClerkKey = lines.some((l) => l.type === "entry" && l.key in vars);
  if (!hadClerkKey && result.length > 0) {
    result.push({ type: "blank" });
    result.push({ type: "comment", raw: "# Clerk" });
  }

  for (const [key, value] of toAppend) {
    result.push({ type: "entry", key, value, raw: `${key}=${value}` });
  }

  return result;
}

export function serializeEnvFile(lines: EnvLine[]): string {
  const out = lines
    .map((line) => {
      if (line.type === "blank") return "";
      if (line.type === "comment") return line.raw;
      return line.raw;
    })
    .join("\n");
  return out + "\n";
}
