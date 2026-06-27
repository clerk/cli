import { throwUsageError, ERROR_CODE } from "./errors.ts";

const INPUT_JSON_FLAG = "--input-json";
const FILE_PREFIX = "@";
const STDIN_MARKER = "-";

type JsonObject = Record<string, unknown>;

/**
 * Convert a camelCase, snake_case, or already-kebab-case key to kebab-case.
 *
 *   "dryRun"   → "dry-run"
 *   "noSkills" → "no-skills"
 *   "dry_run"  → "dry-run"
 *   "dry-run"  → "dry-run"
 */
export function toKebabCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function rejectNested(key: string): never {
  throwUsageError(
    `Nested objects are not supported in --input-json. Key "${key}" must be a flat value.`,
    undefined,
    ERROR_CODE.INVALID_JSON,
  );
}

/**
 * Convert a single JSON entry into argv-style flag tokens.
 *
 * Returns an empty array for entries that should be absent from argv
 * (boolean `false`, `null`, `undefined`, empty arrays).
 */
function entryToFlags(key: string, value: unknown): string[] {
  const flag = `--${toKebabCase(key)}`;

  if (value === true) return [flag];
  if (value === false || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => [flag, String(item)]);
  if (typeof value === "object") rejectNested(key);

  return [flag, String(value)];
}

function expandJsonToFlags(json: JsonObject): string[] {
  return Object.entries(json).flatMap(([key, value]) => entryToFlags(key, value));
}

async function readJsonFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throwUsageError(`File not found: ${path}`, undefined, ERROR_CODE.FILE_NOT_FOUND);
  }
  return file.text();
}

/**
 * Read all of stdin as a UTF-8 string.
 * Uses Bun.stdin, which is a `ReadableStream<Uint8Array>`.
 */
async function readStdin(): Promise<string> {
  const text = await Bun.stdin.text();
  if (!text.trim()) {
    throwUsageError(
      "No JSON received on stdin. Pipe JSON to the command or use --input-json <json|@file>.",
      undefined,
      ERROR_CODE.USAGE_ERROR,
    );
  }
  return text;
}

async function readOptionalStdin(): Promise<string | undefined> {
  const text = await Bun.stdin.text();
  return text.trim() ? text : undefined;
}

/**
 * Resolve the raw --input-json value to a JSON string.
 * - `"-"` reads from stdin.
 * - `"@path"` reads from the given file.
 * - Anything else is treated as an inline JSON string.
 */
function resolveJsonValue(raw: string): Promise<string> | string {
  if (raw === STDIN_MARKER) return readStdin();
  return raw.startsWith(FILE_PREFIX) ? readJsonFile(raw.slice(1)) : raw;
}

function parseJsonString(jsonStr: string): unknown {
  try {
    return JSON.parse(jsonStr);
  } catch {
    throwUsageError(
      "Invalid JSON in --input-json. Please provide valid JSON.",
      undefined,
      ERROR_CODE.INVALID_JSON,
    );
  }
}

function assertJsonObject(parsed: unknown): asserts parsed is JsonObject {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return;
  throwUsageError(
    "--input-json value must be a JSON object, not an array or primitive.",
    undefined,
    ERROR_CODE.INVALID_JSON,
  );
}

function requireValue(argv: string[], idx: number): string {
  const value = argv[idx + 1];
  if (value !== undefined) return value;
  throwUsageError(
    "--input-json requires a JSON string or @file.json argument.",
    undefined,
    ERROR_CODE.USAGE_ERROR,
  );
}

/**
 * Check whether stdin has piped data available (i.e. is not a TTY).
 */
function hasStdinPipe(): boolean {
  return !process.stdin.isTTY;
}

/**
 * Process an argv array: find `--input-json`, expand JSON to flags, return
 * a new argv with the expanded flags spliced in (so explicit CLI flags that
 * appear later in argv naturally take precedence).
 *
 * If `--input-json` is not present but stdin is piped (not a TTY), reads
 * JSON from stdin and appends the expanded flags to the end of argv — UNLESS
 * argv contains a bare `-`, which means a subcommand is itself claiming stdin
 * (e.g. `webhooks verify --payload -`). In that case stdin belongs to the
 * command, so auto-expansion must not consume it.
 *
 * If neither `--input-json` nor stdin pipe is present, returns the original
 * array unchanged.
 */
export async function expandInputJson(argv: string[]): Promise<string[]> {
  const idx = argv.indexOf(INPUT_JSON_FLAG);

  if (idx !== -1) {
    const rawValue = requireValue(argv, idx);
    const jsonStr = await resolveJsonValue(rawValue);
    const parsed = parseJsonString(jsonStr);
    assertJsonObject(parsed);
    argv.splice(idx, 2, ...expandJsonToFlags(parsed));
    return argv;
  }

  // No explicit --input-json flag — auto-detect piped stdin, but yield stdin to
  // a subcommand that explicitly claims it with a bare `-` argument.
  if (hasStdinPipe() && !argv.includes(STDIN_MARKER)) {
    const jsonStr = await readOptionalStdin();
    if (jsonStr === undefined) return argv;
    const parsed = parseJsonString(jsonStr);
    assertJsonObject(parsed);
    // Append expanded flags at the end; explicit CLI flags already in argv
    // appear before these, so they naturally take precedence (last-flag-wins).
    argv.push(...expandJsonToFlags(parsed));
  }

  return argv;
}
