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

/**
 * The env files read back when resolving a value, as opposed to written to.
 *
 * Deliberately shorter than {@link ENV_FILE_CANDIDATES}: the runtime has
 * already loaded every `.env*` variant it recognises into `process.env`, which
 * {@link findEnvValue} checks first. This list only has to cover the case where
 * the CLI's own process did not load the file — a different cwd at startup, or
 * a runtime with no dotenv support.
 */
const ENV_FILES = [".env", ".env.local"];

export interface FindEnvValueOptions {
  /** Injectable in tests; defaults to the real environment. */
  env?: Record<string, string | undefined>;
  /** Lowest priority first — a later file overrides an earlier one. */
  files?: readonly string[];
}

export interface LocatedEnvValue {
  value: string;
  /** Where it came from, for `--verbose` (`CLERK_SECRET_KEY env var`, `.env.local`). */
  source: string;
}

/**
 * Looks for a value under any of `names`, in the order the app itself would
 * resolve one: the environment first, then env files with a later file
 * overriding an earlier one.
 *
 * This is the CLI's one way to read a project-level setting. Reading
 * `process.env` directly instead skips the file fallback and reports no source,
 * so a command that does it cannot explain where its input came from.
 */
export async function findEnvValue(
  cwd: string,
  names: string[],
  options: FindEnvValueOptions = {},
): Promise<LocatedEnvValue | undefined> {
  const { env = process.env, files = ENV_FILES } = options;

  for (const name of new Set(names)) {
    const value = env[name];
    if (value) return { value, source: `${name} env var` };
  }

  // Priority is by name, not by position: the framework-specific name beats
  // the generic fallback even when the generic one appears later in the same
  // file. Within one name, a later file still overrides an earlier one.
  const foundByName = new Map<string, LocatedEnvValue>();
  for (const envFile of files) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type !== "entry" || !line.value) continue;
      if (names.includes(line.key)) {
        foundByName.set(line.key, { value: line.value, source: envFile });
      }
    }
  }

  for (const name of names) {
    const located = foundByName.get(name);
    if (located) return located;
  }
  return undefined;
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
    const key = match[2]!;
    let value = match[3]!;
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
    const value = remaining[line.key]!;
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
