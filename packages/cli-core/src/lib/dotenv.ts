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

/**
 * Returns the first candidate from ENV_FILE_CANDIDATES that exists on disk,
 * or `fallback` if none do.
 */
export async function findExistingEnvFile(cwd: string, fallback: string): Promise<string> {
  for (const candidate of ENV_FILE_CANDIDATES) {
    if (await Bun.file(join(cwd, candidate)).exists()) return candidate;
  }
  return fallback;
}

export type EnvLine =
  | { type: "comment"; raw: string }
  | { type: "blank" }
  | { type: "entry"; key: string; value: string; raw: string };

const ENTRY_RE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Unquoted values: trim, and drop a trailing ` # comment`. Quoted values keep inner spaces. */
function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end !== -1) return trimmed.slice(1, end);
  }
  const comment = rawValue.search(/\s#/);
  const body = comment === -1 ? rawValue : rawValue.slice(0, comment);
  return body.trim();
}

export function parseEnvFile(content: string): EnvLine[] {
  if (!content) return [];
  const raw = content.endsWith("\n") ? content.slice(0, -1) : content;
  return raw.split("\n").map((line): EnvLine => {
    const stripped = stripCr(line);
    if (stripped.trim() === "") return { type: "blank" };
    const match = stripped.match(ENTRY_RE);
    if (!match) return { type: "comment", raw: stripped };
    const key = match[2]!;
    const value = parseEnvValue(match[3]!);
    return { type: "entry", key, value, raw: stripped };
  });
}

export function envFileHasClerkKeys(content: string): boolean {
  return parseEnvFile(content).some(
    (line) =>
      line.type === "entry" &&
      (line.key === "CLERK_SECRET_KEY" ||
        line.key === "CLERK_PUBLISHABLE_KEY" ||
        line.key.endsWith("_CLERK_PUBLISHABLE_KEY")),
  );
}

function rewriteEntryRaw(line: Extract<EnvLine, { type: "entry" }>, value: string): string {
  const match = line.raw.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/);
  if (!match) return `${line.key}=${value}`;
  const prefix = match[1]!;
  const rest = match[2]!;
  const trimmed = rest.trimStart();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    return `${prefix}${quote}${value}${quote}`;
  }
  const comment = rest.match(/(\s+#.*)$/);
  return `${prefix}${value}${comment?.[1] ?? ""}`;
}

export function mergeEnvVars(lines: EnvLine[], vars: Record<string, string>): EnvLine[] {
  const remaining = { ...vars };
  const result = lines.map((line): EnvLine => {
    if (line.type !== "entry" || !(line.key in remaining)) return line;
    const value = remaining[line.key]!;
    delete remaining[line.key];
    return { type: "entry", key: line.key, value, raw: rewriteEntryRaw(line, value) };
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
